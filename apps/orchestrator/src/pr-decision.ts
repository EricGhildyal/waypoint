/**
 * What to do with one open pull request, decided from a snapshot of its GitHub
 * state. Pure on purpose — no database, no network — so every rule here is
 * unit-tested (pr-decision.test.ts) and the polling code only fetches and acts.
 */

export interface PrReview {
  author: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  body: string;
  /** The commit the review was submitted against. */
  commitId: string;
  submittedAt: Date;
}

export interface PrComment {
  author: string;
  body: string;
  /**
   * When the comment became visible. For an inline comment that is its
   * review's submit time, not its own creation time: a comment drafted in a
   * pending review is created long before anyone can see it.
   */
  at: Date;
  /** Inline review comments only. */
  path?: string;
  line?: number | null;
}

/** A check run that finished unsuccessfully on the head commit. */
export interface FailedCheck {
  /** Check run id — for GitHub Actions also the job id its log is fetched by. */
  id: number;
  name: string;
  url: string;
  /** The check's own title/summary, when it gave one. */
  summary: string;
  /** Run by GitHub Actions, i.e. its log can be downloaded. */
  actions: boolean;
}

export interface PrChecks {
  failed: FailedCheck[];
  /** Some check on the head commit has not finished yet. */
  pending: boolean;
  /** How many checks ran at all — zero means the repository has no CI. */
  total: number;
}

export interface PrSnapshot {
  state: "open" | "closed";
  merged: boolean;
  headSha: string;
  /** GitHub computes this lazily: null means "not known yet, ask again". */
  mergeable: boolean | null;
  /** GitHub's one-word summary of conflicts, checks and branch protection. */
  mergeableState: string;
  reviews: PrReview[];
  comments: PrComment[];
  checks: PrChecks;
}

export interface PrContext {
  /** Lower-cased logins whose reviews and comments count. */
  trusted: Set<string>;
  /** Everything at or before this has already been handed to an agent. */
  cursor: Date | null;
  now: Date;
  /** The head commit whose failing checks an agent was last given, and how many such rounds ran. */
  ciFix: { sha: string | null; count: number };
}

export type PrDecision =
  | { action: "done" }
  | { action: "cancelled" }
  | { action: "sync" }
  | { action: "merge"; sha: string }
  | {
      action: "feedback";
      /** The user's comments, numbered; empty when the round is only about checks. */
      text: string;
      /** Newest comment included — null when there were none (a checks-only round). */
      cursor: Date | null;
      /** Failing checks to fix in the same round, with the commit they failed on. */
      ci?: { sha: string; checks: FailedCheck[] };
    }
  | { action: "wait"; reason: string };

/**
 * A burst of comments is handled as one round: nothing starts until the newest
 * one is this old. It also keeps a review that is still being typed from being
 * picked up half-finished.
 */
export const QUIET_WINDOW_MS = 2 * 60 * 1000;

/**
 * `mergeable_state` values that mean "nothing stands in the way": no conflicts,
 * required checks green, branch protection satisfied. Everything else (blocked,
 * behind, unstable, unknown, draft) waits — which is how a failing or pending
 * check holds a merge back without Waypoint reading check runs itself.
 */
const READY_STATES = new Set(["clean", "has_hooks"]);

/**
 * How many times failing checks are handed to an agent on one pull request.
 * Past that the failure is probably not something a code change fixes (a
 * flaky job, a missing secret, broken CI config) and a person should look.
 */
export const MAX_CI_FIX_ROUNDS = 3;

/** Wait reasons that are simply the normal state of an open PR — not worth a log line. */
export const IDLE_REASONS = new Set(["waiting for review", "feedback is still arriving"]);

/**
 * The approval in force, if any. Each reviewer's verdict is their latest
 * APPROVED or CHANGES_REQUESTED review — a plain "commented" review does not
 * withdraw an approval, as on GitHub — and one reviewer's approval does not
 * override another's outstanding request for changes.
 */
function standingApproval(reviews: PrReview[]): PrReview | undefined {
  const verdicts = new Map<string, PrReview>();
  for (const r of reviews) {
    if (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED") {
      verdicts.set(r.author.toLowerCase(), r);
    }
  }
  const standing = [...verdicts.values()];
  return standing.some((r) => r.state === "CHANGES_REQUESTED")
    ? undefined
    : standing.findLast((r) => r.state === "APPROVED");
}

/** The trusted, submitted reviews, oldest first. */
function trustedReviews(snap: PrSnapshot, trusted: Set<string>): PrReview[] {
  return snap.reviews
    .filter(
      (r) =>
        trusted.has(r.author.toLowerCase()) && r.state !== "PENDING" && r.state !== "DISMISSED",
    )
    .toSorted((a, b) => a.submittedAt.getTime() - b.submittedAt.getTime());
}

/** What the task page shows about an open pull request. */
export interface PrStatus {
  checks: "passing" | "failing" | "pending" | "none";
  /** A trusted approval stands on the current head commit. */
  approved: boolean;
  /** One line on what is happening or what is being waited for. */
  note: string;
}

export function summarizePr(snap: PrSnapshot, ctx: PrContext, decision: PrDecision): PrStatus {
  const approval = standingApproval(trustedReviews(snap, ctx.trusted));
  const notes: Record<PrDecision["action"], string> = {
    done: "merged",
    cancelled: "closed",
    merge: "approved — merging",
    sync: "bringing the branch up to date with the default branch",
    feedback: "",
    wait: "",
  };
  let note = notes[decision.action];
  if (decision.action === "wait") note = decision.reason;
  if (decision.action === "feedback") {
    note = decision.ci
      ? decision.text
        ? "handing your comments and the failing checks to an agent"
        : "handing the failing checks to an agent"
      : "handing your comments to an agent";
  }
  return {
    checks:
      snap.checks.total === 0
        ? "none"
        : snap.checks.pending
          ? "pending"
          : snap.checks.failed.length
            ? "failing"
            : "passing",
    approved: approval !== undefined && approval.commitId === snap.headSha,
    note,
  };
}

export function decidePrAction(snap: PrSnapshot, ctx: PrContext): PrDecision {
  if (snap.merged) return { action: "done" };
  if (snap.state === "closed") return { action: "cancelled" };

  const reviews = trustedReviews(snap, ctx.trusted);
  const comments = snap.comments.filter((c) => ctx.trusted.has(c.author.toLowerCase()));

  // Failing checks get a fix round of their own — once per head commit (a
  // round that pushes nothing must not repeat), and only so many times.
  const ciFailing = snap.checks.failed.length > 0 && !snap.checks.pending;
  const ciFixable =
    ciFailing && ctx.ciFix.sha !== snap.headSha && ctx.ciFix.count < MAX_CI_FIX_ROUNDS;
  const ci = ciFixable ? { sha: snap.headSha, checks: snap.checks.failed } : undefined;

  // Everything trusted that is newer than the cursor, i.e. not yet handed to
  // an agent. Computed before the approval is looked at: an approval must not
  // hide a comment that nobody has acted on.
  const after = ctx.cursor?.getTime() ?? 0;
  const items: Array<{ at: Date; text: string }> = [
    ...reviews
      .filter((r) => r.submittedAt.getTime() > after)
      .filter((r) => r.state === "CHANGES_REQUESTED" || r.body.trim() !== "")
      .map((r) => ({
        at: r.submittedAt,
        text:
          r.state === "CHANGES_REQUESTED"
            ? `Review (changes requested): ${r.body.trim() || "(no summary — see the inline comments)"}`
            : `Review comment: ${r.body.trim()}`,
      })),
    ...comments
      .filter((c) => c.at.getTime() > after)
      .map((c) => ({
        at: c.at,
        text: c.path
          ? `Inline comment on \`${c.path}\`${c.line ? ` line ${c.line}` : ""}: ${c.body.trim()}`
          : `Comment: ${c.body.trim()}`,
      })),
  ].toSorted((a, b) => a.at.getTime() - b.at.getTime());

  const approval = standingApproval(reviews);
  if (approval) {
    const approvedAt = approval.submittedAt.getTime();
    // Remarks submitted with the approval itself ("LGTM, one nit") ride along
    // with it. Anything else pending — before or after — gets addressed first.
    const unaddressed = items.some((item) => item.at.getTime() !== approvedAt);
    if (!unaddressed) {
      // Approval covers the commit it was given on. Anything pushed since —
      // including Waypoint's own feedback fixes — needs a fresh look.
      if (approval.commitId !== snap.headSha) {
        return {
          action: "wait",
          reason: "approved, but new commits were pushed since — approve again",
        };
      }
      // conflicting, or the base requires an up-to-date branch: bring it up to date
      if (snap.mergeable === false || snap.mergeableState === "behind") return { action: "sync" };
      if (READY_STATES.has(snap.mergeableState)) return { action: "merge", sha: snap.headSha };
      // not mergeable yet; unless failing checks are the reason and an agent
      // can still be sent after them (below), all there is to do is wait
      if (!ci) {
        return {
          action: "wait",
          reason: ciFailing
            ? "approved, but checks are failing and the automatic fix attempts are used up"
            : `approved, waiting on GitHub (${snap.mergeableState})`,
        };
      }
    }
  }

  const newest = items.at(-1);
  if (newest) {
    if (ctx.now.getTime() - newest.at.getTime() < QUIET_WINDOW_MS) {
      return { action: "wait", reason: "feedback is still arriving" };
    }
    return {
      action: "feedback",
      text: items.map((item, i) => `${i + 1}. ${item.text}`).join("\n\n"),
      cursor: newest.at,
      // the round pushes new commits anyway — fix the checks in the same one
      ...(ci ? { ci } : {}),
    };
  }

  if (ci) return { action: "feedback", text: "", cursor: null, ci };

  // Nothing to address, but the PR no longer merges: bring the branch up to date.
  if (snap.mergeable === false) return { action: "sync" };
  if (ciFailing) {
    return {
      action: "wait",
      reason:
        ctx.ciFix.sha === snap.headSha
          ? "checks are failing and the last automatic fix attempt changed nothing — needs a look"
          : `checks are still failing after ${MAX_CI_FIX_ROUNDS} automatic fix attempts — needs a look`,
    };
  }
  return { action: "wait", reason: "waiting for review" };
}
