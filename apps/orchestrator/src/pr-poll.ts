import { promises as fs } from "node:fs";
import { Octokit } from "octokit";
import {
  ACTIVE_STATUSES,
  PR_FEEDBACK_ARTIFACT,
  PR_REPLY_ARTIFACT,
  artifactDir,
  artifactPath,
  db,
  emitEvent,
  getNumberSetting,
  getSetting,
  transition,
} from "@waypoint/core";
import type { Project, Task } from "@waypoint/core";
import { githubTokenFor, parseGithubRepo, readPrBody } from "./pr";
import {
  type FailedCheck,
  IDLE_REASONS,
  type PrChecks,
  type PrSnapshot,
  decidePrAction,
  summarizePr,
} from "./pr-decision";
import { gitPatFor } from "./secrets";

const POLL_INTERVAL_MS = 60 * 1000;
let lastPoll = 0;

/** GitHub rejects comment bodies over 65,536 characters. */
const MAX_COMMENT_CHARS = 60_000;

/**
 * Tasks whose pull request needs a runner (feedback to address, a conflict)
 * but found every slot taken at the last poll. fillSlots() holds that many
 * slots back, or a backlog of queued tasks would refill each one as it frees
 * and the person waiting on their PR would wait behind the whole queue.
 */
const waitingForSlot = new Set<string>();
export const prRoundsWaiting = (): number => waitingForSlot.size;

/** Last "why nothing is happening" shown per task, so it is logged once, not every minute. */
const lastWaitReason = new Map<string, string>();

/**
 * Appended (invisibly) to every comment Waypoint posts. Without a bot account
 * those comments are authored by the human's own login — a trusted one — and
 * would otherwise come straight back in as feedback to address.
 */
const WAYPOINT_MARKER = "<!-- waypoint -->";

type OpenPrTask = Task & { project: Project };

/**
 * Watch every open Waypoint pull request (§7): close the PRs of cancelled
 * tasks, post the agent's reply from the last feedback round, then act on what
 * the human did — merge on approval,
 * hand comments to an agent, re-sync a conflicting branch, or close the task
 * out when the PR was merged or closed by hand. Polled about once a minute;
 * the decision itself lives in pr-decision.ts.
 */
export async function pollOpenPrs(): Promise<void> {
  if (Date.now() - lastPoll < POLL_INTERVAL_MS) {
    // a "Merge now" press should not wait out the rest of the minute
    const urgent = await db.task.count({
      where: { status: "PR_OPEN", prMergeRequestedAt: { not: null } },
    });
    if (!urgent) return;
  }
  lastPoll = Date.now();

  const tasks = await db.task.findMany({
    where: { status: "PR_OPEN", prNumber: { not: null } },
    include: { project: true },
  });
  await closeCancelledPrs();

  waitingForSlot.clear();
  for (const task of tasks) {
    try {
      await pollOne(task);
    } catch (err) {
      // GitHub being unreachable is not the task's failure — try again next poll
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[pr-poll] task ${task.id}: ${message}`);
    }
  }
}

/** Cancelled tasks whose pull request is known to be closed (or beyond our reach). */
const prClosedFor = new Set<string>();

/**
 * Cancelling a task closes its pull request: a PR left open for work nobody is
 * doing any more would sit there looking reviewable, and approving it would do
 * nothing. Only recent cancellations are checked — after a restart each costs
 * one GitHub read to find the PR already closed.
 */
async function closeCancelledPrs(): Promise<void> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const tasks = await db.task.findMany({
    where: { status: "CANCELLED", prNumber: { not: null }, endedAt: { gt: since } },
    include: { project: true },
  });
  for (const task of tasks) {
    if (prClosedFor.has(task.id)) continue;
    try {
      const repo = parseGithubRepo(task.project.repoUrl);
      const token = await githubTokenFor(task.projectId);
      if (repo && token && task.prNumber !== null) {
        const octokit = new Octokit({ auth: token });
        const pr = { owner: repo.owner, repo: repo.repo, pull_number: task.prNumber };
        const { data } = await octokit.rest.pulls.get(pr);
        // already closed: by the user on GitHub (which is what cancelled the
        // task), or by an earlier pass
        if (data.state === "open") {
          await octokit.rest.issues.createComment({
            owner: pr.owner,
            repo: pr.repo,
            issue_number: pr.pull_number,
            body: `Closed because the Waypoint task was cancelled.\n\n${WAYPOINT_MARKER}`,
          });
          await octokit.rest.pulls.update({ ...pr, state: "closed" });
          await emitEvent(task.id, "LOG", { level: "info", line: "pull request closed" });
          console.log(`[pr-poll] closed ${task.prUrl} for cancelled task ${task.id}`);
        }
      }
      prClosedFor.add(task.id);
    } catch (err) {
      // left out of the set, so the next poll tries again
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[pr-poll] could not close the PR of cancelled task ${task.id}: ${message}`);
    }
  }
}

async function pollOne(task: OpenPrTask): Promise<void> {
  const repo = parseGithubRepo(task.project.repoUrl);
  const token = await githubTokenFor(task.projectId);
  if (!repo || !token || task.prNumber === null) return;
  const octokit = new Octokit({ auth: token });
  const pr = { owner: repo.owner, repo: repo.repo, pull_number: task.prNumber };

  // A reply that cannot be posted must not stop the PR being watched: the
  // merge, the close and new feedback all come after this line.
  await postPendingReply(octokit, task, pr).catch((err) => {
    console.warn(`[pr-poll] task ${task.id}: could not post the reply: ${String(err)}`);
  });

  const trusted = await trustedLogins(task.projectId);
  if (trusted.size === 0) {
    await noteWaitReason(
      task.id,
      "nobody's comments are trusted — set a GitHub PAT or Trusted GitHub logins in Settings",
    );
  }

  const snapshot = await fetchSnapshot(octokit, pr);

  // "Merge now" on the task page: the user's own decision, so it does not wait
  // for a review. GitHub still enforces branch protection and conflicts. The
  // request is cleared first — a merge GitHub refuses must not retry forever.
  if (task.prMergeRequestedAt && snapshot.state === "open" && !snapshot.merged) {
    await db.task.update({ where: { id: task.id }, data: { prMergeRequestedAt: null } });
    try {
      await mergePr(octokit, task, pr, snapshot.headSha, "merged at your request");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await emitEvent(task.id, "LOG", {
        level: "warn",
        line: `pull request: GitHub refused the merge — ${message.slice(0, 300)}`,
      });
    }
    return;
  }

  const ctx = {
    trusted,
    cursor: task.prFeedbackCursor,
    now: new Date(),
    ciFix: { sha: task.prCiFixSha, count: task.prCiFixCount },
  };
  const decision = decidePrAction(snapshot, ctx);

  // what the task page shows — written only when it changes
  const status = summarizePr(snapshot, ctx, decision);
  if (JSON.stringify(task.prStatus) !== JSON.stringify(status)) {
    await db.task.update({ where: { id: task.id }, data: { prStatus: { ...status } } });
  }
  if (decision.action !== "wait") lastWaitReason.delete(task.id);

  switch (decision.action) {
    case "wait":
      // anything beyond "waiting for you" is the user wondering why nothing
      // is happening — put it in the activity log
      if (!IDLE_REASONS.has(decision.reason)) await noteWaitReason(task.id, decision.reason);
      return;
    case "done":
      await transition(task.id, "DONE", { reason: "pull request merged" });
      return;
    case "cancelled":
      await transition(task.id, "CANCELLED", { reason: "pull request closed without merging" });
      return;
    case "merge":
      await mergePr(octokit, task, pr, decision.sha, "approved — merged");
      return;
    case "feedback":
    case "sync": {
      // Reviving the runner takes a slot like any other running task. When
      // none is free, do nothing: the same decision comes up again next poll.
      // Same rule as fillSlots: never start a container into an exhausted
      // Claude window.
      const resetsAt = Date.parse(await getSetting("rateLimitResetsAt"));
      if (Number.isFinite(resetsAt) && resetsAt > Date.now()) return;
      const max = await getNumberSetting("maxParallelTasks");
      const active = await db.task.count({ where: { status: { in: ACTIVE_STATUSES } } });
      if (active >= max) {
        waitingForSlot.add(task.id);
        return;
      }

      const ci = decision.action === "feedback" ? decision.ci : undefined;
      const text =
        decision.action === "feedback"
          ? [decision.text, ci ? await failingChecksSection(octokit, pr, ci) : ""]
              .filter(Boolean)
              .join("\n\n")
          : "";
      await fs.mkdir(artifactDir(task.id), { recursive: true });
      await fs.writeFile(artifactPath(task.id, PR_FEEDBACK_ARTIFACT), text, "utf8");
      // Transition before advancing the cursors: a crash in between repeats a
      // round, the other order would silently drop the user's comments.
      await transition(task.id, "ADDRESSING_FEEDBACK", {
        currentStage: "PR_FEEDBACK",
        reason:
          decision.action === "sync"
            ? "pull request conflicts with the default branch"
            : decision.text
              ? "pull request feedback received"
              : "pull request checks are failing",
      });
      if (decision.action === "feedback") {
        await db.task.update({
          where: { id: task.id },
          data: {
            ...(decision.cursor ? { prFeedbackCursor: decision.cursor } : {}),
            ...(ci ? { prCiFixSha: ci.sha, prCiFixCount: { increment: 1 } } : {}),
          },
        });
      }
      return;
    }
  }
}

/** Merge the pull request at `sha`, finish the task, and tidy the branch away. */
async function mergePr(
  octokit: Octokit,
  task: OpenPrTask,
  pr: { owner: string; repo: string; pull_number: number },
  sha: string,
  logLine: string,
): Promise<void> {
  const method = await getSetting("prMergeMethod");
  // `sha` makes GitHub refuse if the head moved since the state we read, so
  // neither a stale approval nor a stale button press can merge commits nobody
  // looked at.
  await octokit.rest.pulls.merge({
    ...pr,
    sha,
    merge_method: method === "squash" || method === "rebase" ? method : "merge",
  });
  await emitEvent(task.id, "LOG", { level: "info", line: `pull request ${logLine}` });
  await transition(task.id, "DONE", { reason: "pull request merged" });
  if (task.branchName) {
    await octokit.rest.git
      .deleteRef({ owner: pr.owner, repo: pr.repo, ref: `heads/${task.branchName}` })
      .catch(() => {}); // best effort — the repo may already delete merged branches
  }
  console.log(`[pr-poll] merged ${task.prUrl} for task ${task.id}`);
}

const LOG_TAIL_CHARS = 6000;

/**
 * The part of a feedback round's brief that covers failing checks: each
 * check's name, link, own summary, and the end of its log — where the error
 * is, nearly always. Logs are only fetched here, when a round is actually
 * starting, not on every poll.
 */
async function failingChecksSection(
  octokit: Octokit,
  pr: { owner: string; repo: string },
  ci: { sha: string; checks: FailedCheck[] },
): Promise<string> {
  const parts = [
    "## Failing checks",
    `These checks failed on the latest commit (\`${ci.sha.slice(0, 7)}\`).`,
  ];
  for (const check of ci.checks) {
    parts.push(`### ${check.name}\n\n${check.url}${check.summary ? `\n\n${check.summary}` : ""}`);
    if (!check.actions) continue;
    try {
      const { data } = await octokit.rest.actions.downloadJobLogsForWorkflowRun({
        owner: pr.owner,
        repo: pr.repo,
        job_id: check.id,
      });
      const log = String(data);
      parts.push(`End of the log:\n\n\`\`\`\n${log.slice(-LOG_TAIL_CHARS)}\n\`\`\``);
    } catch {
      // the token may not be allowed to read Actions logs — the link still helps
      parts.push("(The log could not be downloaded — reproduce the check locally.)");
    }
  }
  return parts.join("\n\n");
}

/** Post the reply the agent wrote in the last feedback round, exactly once. */
async function postPendingReply(
  octokit: Octokit,
  task: OpenPrTask,
  pr: { owner: string; repo: string; pull_number: number },
): Promise<void> {
  const replyFile = artifactPath(task.id, PR_REPLY_ARTIFACT);
  let reply: string;
  try {
    reply = await fs.readFile(replyFile, "utf8");
  } catch {
    return; // nothing pending
  }
  if (reply.trim()) {
    const text =
      reply.trim().length > MAX_COMMENT_CHARS
        ? `${reply.trim().slice(0, MAX_COMMENT_CHARS)}\n\n_(reply truncated)_`
        : reply.trim();
    await octokit.rest.issues.createComment({
      owner: pr.owner,
      repo: pr.repo,
      issue_number: pr.pull_number,
      body: `${text}\n\n${WAYPOINT_MARKER}`,
    });
    // the round may have changed what the PR does — keep its description true
    await octokit.rest.pulls.update({ ...pr, body: await readPrBody(task.id) }).catch(() => {});
  }
  await fs.rm(replyFile, { force: true });
}

/** Put a "why nothing is happening" line in the task's activity log, once per reason. */
async function noteWaitReason(taskId: string, reason: string): Promise<void> {
  if (lastWaitReason.get(taskId) === reason) return;
  lastWaitReason.set(taskId, reason);
  await emitEvent(taskId, "LOG", { level: "warn", line: `pull request: ${reason}` });
}

async function fetchSnapshot(
  octokit: Octokit,
  pr: { owner: string; repo: string; pull_number: number },
): Promise<PrSnapshot> {
  const [{ data }, reviews, inline, conversation] = await Promise.all([
    octokit.rest.pulls.get(pr),
    octokit.paginate(octokit.rest.pulls.listReviews, { ...pr, per_page: 100 }),
    octokit.paginate(octokit.rest.pulls.listReviewComments, { ...pr, per_page: 100 }),
    octokit.paginate(octokit.rest.issues.listComments, {
      owner: pr.owner,
      repo: pr.repo,
      issue_number: pr.pull_number,
      per_page: 100,
    }),
  ]);

  const checks = await fetchChecks(octokit, pr, data.head.sha);

  const submittedAt = new Map(
    reviews.map((r) => [r.id, r.submitted_at ? new Date(r.submitted_at) : null]),
  );
  // a comment in a review that is still a draft is not feedback yet; it comes
  // back, dated by the submit time, once the review is submitted
  const draft = (reviewId: number | null | undefined) =>
    reviewId != null && submittedAt.get(reviewId) === null;
  const fromWaypoint = (body: string | null | undefined) => (body ?? "").includes(WAYPOINT_MARKER);

  return {
    state: data.state === "closed" ? "closed" : "open",
    merged: data.merged,
    headSha: data.head.sha,
    mergeable: data.mergeable,
    mergeableState: data.mergeable_state,
    checks,
    reviews: reviews
      .filter((r) => r.submitted_at && !fromWaypoint(r.body))
      .map((r) => ({
        author: r.user?.login ?? "",
        state: r.state as PrSnapshot["reviews"][number]["state"],
        body: r.body ?? "",
        commitId: r.commit_id ?? "",
        submittedAt: new Date(r.submitted_at as string),
      })),
    comments: [
      ...inline
        .filter((c) => !fromWaypoint(c.body) && !draft(c.pull_request_review_id))
        .map((c) => ({
          author: c.user?.login ?? "",
          body: c.body,
          // visible from its review's submit time, see PrComment.at
          at:
            (c.pull_request_review_id ? submittedAt.get(c.pull_request_review_id) : null) ??
            new Date(c.created_at),
          path: c.path,
          line: c.line ?? c.original_line ?? null,
        })),
      ...conversation
        .filter((c) => !fromWaypoint(c.body))
        .map((c) => ({
          author: c.user?.login ?? "",
          body: c.body ?? "",
          at: new Date(c.created_at),
        })),
    ],
  };
}

/** The check runs on the head commit. A token that cannot read checks sees none. */
async function fetchChecks(
  octokit: Octokit,
  pr: { owner: string; repo: string },
  sha: string,
): Promise<PrChecks> {
  try {
    const runs = await octokit.paginate(octokit.rest.checks.listForRef, {
      owner: pr.owner,
      repo: pr.repo,
      ref: sha,
      per_page: 100,
    });
    return {
      total: runs.length,
      pending: runs.some((run) => run.status !== "completed"),
      failed: runs
        .filter((run) => run.conclusion === "failure" || run.conclusion === "timed_out")
        .map((run) => ({
          id: run.id,
          name: run.name,
          url: run.html_url ?? "",
          summary: [run.output?.title, run.output?.summary].filter(Boolean).join("\n\n"),
          actions: run.app?.slug === "github-actions",
        })),
    };
  } catch {
    return { failed: [], pending: false, total: 0 };
  }
}

/** GitHub login behind each PAT, looked up once per token for the process lifetime. */
const patOwners = new Map<string, string>();

/**
 * Whose comments and approvals count. Agents run with every permission and the
 * repository may be public, so text from anyone else must never reach one.
 * Defaults to the owner of the project's PAT — the person Waypoint works for.
 */
async function trustedLogins(projectId: string): Promise<Set<string>> {
  const configured = (await getSetting("prTrustedLogins"))
    .split(",")
    .map((login) => login.trim().replace(/^@/, "").toLowerCase())
    .filter(Boolean);
  if (configured.length) return new Set(configured);

  const pat = await gitPatFor(projectId);
  if (!pat) return new Set();
  let owner = patOwners.get(pat);
  if (!owner) {
    const { data } = await new Octokit({ auth: pat }).rest.users.getAuthenticated();
    owner = data.login.toLowerCase();
    patOwners.set(pat, owner);
  }
  return new Set([owner]);
}
