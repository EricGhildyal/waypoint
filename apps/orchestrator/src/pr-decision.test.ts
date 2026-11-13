import { describe, expect, test } from "bun:test";
import {
  type PrComment,
  type PrContext,
  type PrReview,
  type PrSnapshot,
  decidePrAction,
  summarizePr,
} from "./pr-decision";

/** Minutes past a fixed epoch. */
const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes));

const HEAD = "sha-head";

function snapshot(over: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    state: "open",
    merged: false,
    headSha: HEAD,
    mergeable: true,
    mergeableState: "clean",
    reviews: [],
    comments: [],
    checks: { failed: [], pending: false, total: 0 },
    ...over,
  };
}

function review(over: Partial<PrReview> & Pick<PrReview, "state" | "submittedAt">): PrReview {
  return { author: "eric", body: "", commitId: HEAD, ...over };
}

function comment(over: Partial<PrComment> & Pick<PrComment, "at">): PrComment {
  return { author: "eric", body: "please rename this", ...over };
}

/** `now` defaults to well past the quiet window of anything the tests create. */
function ctx(over: Partial<PrContext> = {}): PrContext {
  return {
    trusted: new Set(["eric"]),
    cursor: at(0),
    now: at(600),
    ciFix: { sha: null, count: 0 },
    ...over,
  };
}

describe("decidePrAction", () => {
  test("a merged pull request finishes the task", () => {
    expect(decidePrAction(snapshot({ state: "closed", merged: true }), ctx())).toEqual({
      action: "done",
    });
  });

  test("a pull request closed without merging cancels the task", () => {
    expect(decidePrAction(snapshot({ state: "closed" }), ctx())).toEqual({ action: "cancelled" });
  });

  test("with nothing from the reviewer yet, it waits", () => {
    expect(decidePrAction(snapshot(), ctx()).action).toBe("wait");
  });

  describe("approval", () => {
    const approved = review({ state: "APPROVED", submittedAt: at(10) });

    test("an approval on the head commit merges that commit", () => {
      expect(decidePrAction(snapshot({ reviews: [approved] }), ctx())).toEqual({
        action: "merge",
        sha: HEAD,
      });
    });

    test("an approval given before newer commits does not merge them", () => {
      const stale = review({ state: "APPROVED", submittedAt: at(10), commitId: "sha-old" });
      expect(decidePrAction(snapshot({ reviews: [stale] }), ctx()).action).toBe("wait");
    });

    test("an approval from someone untrusted is ignored", () => {
      const stranger = review({ state: "APPROVED", submittedAt: at(10), author: "stranger" });
      expect(decidePrAction(snapshot({ reviews: [stranger] }), ctx()).action).toBe("wait");
    });

    test("logins are matched case-insensitively", () => {
      const mixedCase = review({ state: "APPROVED", submittedAt: at(10), author: "Eric" });
      expect(decidePrAction(snapshot({ reviews: [mixedCase] }), ctx()).action).toBe("merge");
    });

    test("a later changes-requested review withdraws the approval", () => {
      const reviews = [
        approved,
        review({ state: "CHANGES_REQUESTED", submittedAt: at(20), body: "not yet" }),
      ];
      expect(decidePrAction(snapshot({ reviews }), ctx()).action).toBe("feedback");
    });

    test("pending or failing checks hold the merge back", () => {
      for (const mergeableState of ["blocked", "unstable", "unknown"]) {
        const decision = decidePrAction(snapshot({ reviews: [approved], mergeableState }), ctx());
        expect(decision.action).toBe("wait");
      }
    });

    test("an approved pull request that conflicts is synced, not merged", () => {
      const snap = snapshot({ reviews: [approved], mergeable: false, mergeableState: "dirty" });
      expect(decidePrAction(snap, ctx())).toEqual({ action: "sync" });
    });

    test("comments submitted with the approval do not block the merge", () => {
      const snap = snapshot({
        reviews: [{ ...approved, body: "nice, one nit inline" }],
        comments: [comment({ at: at(10), path: "src/a.ts", line: 3 })],
      });
      expect(decidePrAction(snap, ctx()).action).toBe("merge");
    });

    test("a comment left before the approval is not skipped by it", () => {
      const snap = snapshot({ reviews: [approved], comments: [comment({ at: at(5) })] });
      expect(decidePrAction(snap, ctx()).action).toBe("feedback");
    });

    test("a comment already handed to an agent does not hold the approval back", () => {
      const snap = snapshot({ reviews: [approved], comments: [comment({ at: at(5) })] });
      expect(decidePrAction(snap, ctx({ cursor: at(5) })).action).toBe("merge");
    });

    test("one reviewer's approval does not override another's request for changes", () => {
      const reviews = [
        review({ state: "CHANGES_REQUESTED", submittedAt: at(5), author: "sam", body: "no" }),
        approved,
      ];
      const trusted = new Set(["eric", "sam"]);
      // sam's request was already handled (cursor past it) but never withdrawn
      const decision = decidePrAction(snapshot({ reviews }), ctx({ trusted, cursor: at(6) }));
      expect(decision.action).toBe("wait");
    });

    test("a reviewer who requested changes and then approves has approved", () => {
      const reviews = [
        review({ state: "CHANGES_REQUESTED", submittedAt: at(5), body: "no" }),
        approved,
      ];
      expect(decidePrAction(snapshot({ reviews }), ctx({ cursor: at(6) })).action).toBe("merge");
    });

    test("an approved branch that is behind its base is brought up to date", () => {
      const snap = snapshot({ reviews: [approved], mergeableState: "behind" });
      expect(decidePrAction(snap, ctx())).toEqual({ action: "sync" });
    });

    test("a comment after the approval is addressed before anything merges", () => {
      const snap = snapshot({ reviews: [approved], comments: [comment({ at: at(30) })] });
      expect(decidePrAction(snap, ctx()).action).toBe("feedback");
    });
  });

  describe("feedback", () => {
    test("new comments become one numbered round, oldest first", () => {
      const snap = snapshot({
        comments: [
          comment({ at: at(30), body: "second" }),
          comment({ at: at(20), body: "first", path: "src/a.ts", line: 12 }),
        ],
      });
      const decision = decidePrAction(snap, ctx());
      expect(decision).toEqual({
        action: "feedback",
        text: "1. Inline comment on `src/a.ts` line 12: first\n\n2. Comment: second",
        cursor: at(30),
      });
    });

    test("comments at or before the cursor were already handled", () => {
      const snap = snapshot({ comments: [comment({ at: at(20) })] });
      expect(decidePrAction(snap, ctx({ cursor: at(20) })).action).toBe("wait");
    });

    test("an inline comment drafted before the cursor counts from when its review was submitted", () => {
      // fetchSnapshot dates inline comments by their review's submit time; a
      // comment typed at minute 5 in a review submitted at minute 40 arrives
      // here as at(40) and must not be lost behind a cursor at minute 30
      const snap = snapshot({ comments: [comment({ at: at(40), path: "src/a.ts" })] });
      expect(decidePrAction(snap, ctx({ cursor: at(30) })).action).toBe("feedback");
    });

    test("comments from untrusted accounts never reach an agent", () => {
      const snap = snapshot({ comments: [comment({ at: at(20), author: "stranger" })] });
      expect(decidePrAction(snap, ctx()).action).toBe("wait");
    });

    test("it waits while feedback is still arriving", () => {
      const snap = snapshot({ comments: [comment({ at: at(20) })] });
      expect(decidePrAction(snap, ctx({ now: at(21) })).action).toBe("wait");
      expect(decidePrAction(snap, ctx({ now: at(23) })).action).toBe("feedback");
    });

    test("a changes-requested review with no summary still starts a round", () => {
      const snap = snapshot({
        reviews: [review({ state: "CHANGES_REQUESTED", submittedAt: at(20) })],
      });
      expect(decidePrAction(snap, ctx()).action).toBe("feedback");
    });

    test("an empty 'commented' review on its own is not feedback", () => {
      const snap = snapshot({ reviews: [review({ state: "COMMENTED", submittedAt: at(20) })] });
      expect(decidePrAction(snap, ctx()).action).toBe("wait");
    });
  });

  describe("failing checks", () => {
    const lint = { id: 7, name: "lint", url: "https://ci/7", summary: "", actions: true };
    const failing = { failed: [lint], pending: false, total: 2 };

    test("failing checks start a fix round for the head commit", () => {
      expect(decidePrAction(snapshot({ checks: failing }), ctx())).toEqual({
        action: "feedback",
        text: "",
        cursor: null,
        ci: { sha: HEAD, checks: [lint] },
      });
    });

    test("it waits for every check to finish before acting on a failure", () => {
      const checks = { ...failing, pending: true };
      expect(decidePrAction(snapshot({ checks }), ctx()).action).toBe("wait");
    });

    test("the same commit is not handed over twice", () => {
      const decision = decidePrAction(
        snapshot({ checks: failing }),
        ctx({ ciFix: { sha: HEAD, count: 1 } }),
      );
      expect(decision.action).toBe("wait");
    });

    test("a new commit that still fails gets another round, up to the cap", () => {
      const snap = snapshot({ checks: failing });
      expect(decidePrAction(snap, ctx({ ciFix: { sha: "sha-old", count: 2 } })).action).toBe(
        "feedback",
      );
      expect(decidePrAction(snap, ctx({ ciFix: { sha: "sha-old", count: 3 } })).action).toBe(
        "wait",
      );
    });

    test("comments and failing checks are handled in one round", () => {
      const snap = snapshot({ checks: failing, comments: [comment({ at: at(20) })] });
      const decision = decidePrAction(snap, ctx());
      expect(decision.action === "feedback" && decision.ci?.sha).toBe(HEAD);
      expect(decision.action === "feedback" && decision.cursor).toEqual(at(20));
    });

    test("an approved pull request with failing checks is fixed, not left waiting", () => {
      const snap = snapshot({
        checks: failing,
        mergeableState: "blocked",
        reviews: [review({ state: "APPROVED", submittedAt: at(10) })],
      });
      expect(decidePrAction(snap, ctx()).action).toBe("feedback");
    });

    test("an approved pull request whose failing checks are not required still merges", () => {
      const snap = snapshot({
        checks: failing,
        reviews: [review({ state: "APPROVED", submittedAt: at(10) })],
      });
      expect(decidePrAction(snap, ctx()).action).toBe("merge");
    });
  });

  describe("summarizePr", () => {
    test("reports checks, approval on the head commit, and the reason for waiting", () => {
      const snap = snapshot({
        mergeableState: "blocked",
        checks: { failed: [], pending: true, total: 3 },
        reviews: [review({ state: "APPROVED", submittedAt: at(10) })],
      });
      expect(summarizePr(snap, ctx(), decidePrAction(snap, ctx()))).toEqual({
        checks: "pending",
        approved: true,
        note: "approved, waiting on GitHub (blocked)",
      });
    });

    test("an approval given on an older commit does not count as approved", () => {
      const snap = snapshot({
        reviews: [review({ state: "APPROVED", submittedAt: at(10), commitId: "sha-old" })],
      });
      const status = summarizePr(snap, ctx(), decidePrAction(snap, ctx()));
      expect(status.approved).toBe(false);
      expect(status.checks).toBe("none");
    });
  });

  describe("conflicts", () => {
    test("a conflicting pull request with no feedback is synced", () => {
      expect(decidePrAction(snapshot({ mergeable: false }), ctx())).toEqual({ action: "sync" });
    });

    test("feedback takes priority: its round syncs the branch anyway", () => {
      const snap = snapshot({ mergeable: false, comments: [comment({ at: at(20) })] });
      expect(decidePrAction(snap, ctx()).action).toBe("feedback");
    });

    test("mergeability GitHub has not computed yet is not a conflict", () => {
      expect(decidePrAction(snapshot({ mergeable: null }), ctx()).action).toBe("wait");
    });
  });
});
