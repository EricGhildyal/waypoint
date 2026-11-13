import type { Stage, TaskStatus } from "./generated/prisma/client";
import type { FindingCategory } from "./schemas";

/**
 * Statuses that count against Setting.maxParallelTasks (§5 tick step 3).
 * Single exported constant — the one source of truth for "task is occupying a slot".
 * DRAFT is deliberately absent (like QUEUED/SCHEDULED/BLOCKED): a task waiting on
 * a manual start has no container and must not consume a parallel slot.
 *
 * A task waiting on the user (NEEDS_INPUT, AWAITING_PLAN_APPROVAL, PR_OPEN) is
 * absent too: an agent that is not running should not block one that could,
 * or a few unanswered emails stall the whole queue. The trade: answering such
 * a task resumes it at once, which can put the count over the limit until
 * something finishes — nothing new is started while it is.
 */
export const ACTIVE_STATUSES: TaskStatus[] = [
  "PLANNING",
  "IMPLEMENTING",
  "REVIEWING",
  "TESTING",
  "RATE_LIMITED",
  "OPENING_PR",
  "ADDRESSING_FEEDBACK",
];

/**
 * Statuses in which the runner is (or should be) actively executing a stage.
 * Reconciliation starts a container for any task in one of these, which is how
 * a PR_OPEN task's stopped container comes back for ADDRESSING_FEEDBACK.
 */
export const RUNNING_STAGE_STATUSES: TaskStatus[] = [
  "PLANNING",
  "IMPLEMENTING",
  "REVIEWING",
  "TESTING",
  "ADDRESSING_FEEDBACK",
];

/** Statuses where an idle container gets stopped after 15 min (§5 tick step 4). */
export const IDLE_STATUSES: TaskStatus[] = [
  "NEEDS_INPUT",
  "PAUSED",
  "RATE_LIMITED",
  "AWAITING_PLAN_APPROVAL",
];

export const TERMINAL_STATUSES: TaskStatus[] = ["DONE", "FAILED", "CANCELLED"];

/** Task status a stage maps to while it is running. */
export const STAGE_TO_STATUS: Record<Stage, TaskStatus> = {
  PLANNING: "PLANNING",
  IMPLEMENTATION: "IMPLEMENTING",
  REVIEW: "REVIEWING",
  TESTING: "TESTING",
  PR_FEEDBACK: "ADDRESSING_FEEDBACK",
};

/**
 * The static transition map (§5). Every status change in the entire system goes
 * through transition() — web route handlers, the runner sync endpoint and the
 * orchestrator all share that single write path. It lives here, not beside
 * transition(), so it can be tested without opening the database.
 */
export const ALLOWED_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  // a draft only leaves when the user presses Start (or cancels it)
  DRAFT: ["QUEUED", "CANCELLED"],
  QUEUED: ["DRAFT", "SCHEDULED", "BLOCKED", "PLANNING", "CANCELLED", "FAILED"],
  SCHEDULED: ["QUEUED", "CANCELLED"],
  BLOCKED: ["QUEUED", "NEEDS_INPUT", "CANCELLED"],
  PLANNING: [
    "AWAITING_PLAN_APPROVAL",
    // plan approved while the task sat paused: the runner's IMPLEMENTATION
    // stage-start repairs the status directly from PLANNING
    "IMPLEMENTING",
    "NEEDS_INPUT",
    "PAUSED",
    "RATE_LIMITED",
    "FAILED",
    "CANCELLED",
    // verify runs use the PLANNING stage slot and complete directly
    "DONE",
  ],
  AWAITING_PLAN_APPROVAL: ["PLANNING", "IMPLEMENTING", "PAUSED", "FAILED", "CANCELLED"],
  IMPLEMENTING: ["REVIEWING", "NEEDS_INPUT", "PAUSED", "RATE_LIMITED", "FAILED", "CANCELLED"],
  REVIEWING: [
    "IMPLEMENTING",
    "TESTING",
    "NEEDS_INPUT",
    "PAUSED",
    "RATE_LIMITED",
    "FAILED",
    "CANCELLED",
  ],
  TESTING: [
    "IMPLEMENTING",
    "OPENING_PR",
    "NEEDS_INPUT",
    "PAUSED",
    "RATE_LIMITED",
    "FAILED",
    "CANCELLED",
  ],
  NEEDS_INPUT: [
    "QUEUED",
    "PLANNING",
    "AWAITING_PLAN_APPROVAL",
    "IMPLEMENTING",
    "REVIEWING",
    "TESTING",
    "ADDRESSING_FEEDBACK",
    "PAUSED",
    "FAILED",
    "CANCELLED",
  ],
  PAUSED: [
    "QUEUED",
    "PLANNING",
    "AWAITING_PLAN_APPROVAL",
    "IMPLEMENTING",
    "REVIEWING",
    "TESTING",
    "ADDRESSING_FEEDBACK",
    "NEEDS_INPUT",
    // A stage's last steps (the push) are not interruptible, so its end can
    // land after the pause did. The work is finished; let it through rather
    // than drop it — nothing would ever send that stage end again.
    "OPENING_PR",
    "PR_OPEN",
    "FAILED",
    "CANCELLED",
  ],
  RATE_LIMITED: [
    "PLANNING",
    "IMPLEMENTING",
    "REVIEWING",
    "TESTING",
    "ADDRESSING_FEEDBACK",
    "OPENING_PR", // as for PAUSED: a finished stage's end arriving late
    "PR_OPEN",
    "PAUSED",
    "FAILED",
    "CANCELLED",
  ],
  OPENING_PR: ["PR_OPEN", "FAILED", "CANCELLED"],
  // The PR is open and waiting on the human. It leaves when they comment
  // (ADDRESSING_FEEDBACK), approve or merge (DONE), or close it (CANCELLED).
  PR_OPEN: ["ADDRESSING_FEEDBACK", "DONE", "CANCELLED"],
  ADDRESSING_FEEDBACK: ["PR_OPEN", "NEEDS_INPUT", "PAUSED", "RATE_LIMITED", "FAILED", "CANCELLED"],
  FAILED: [
    // Retry resumes the failed stage (or re-queues when it never started)
    "QUEUED",
    "PLANNING",
    "AWAITING_PLAN_APPROVAL",
    "IMPLEMENTING",
    "REVIEWING",
    "TESTING",
    "OPENING_PR",
    "ADDRESSING_FEEDBACK",
    "CANCELLED",
  ],
  DONE: [],
  CANCELLED: [],
};

export const REVIEW_CYCLE_CAP = 3;
export const TESTING_CYCLE_CAP = 2;

/** Marker prompt identifying a project "Verify" throwaway run (see §9 Projects). */
export const VERIFY_PROMPT_SENTINEL = "__waypoint_verify__";

/**
 * Review findings the agent may fix on its own authority (§7). Everything else
 * goes out as a FINDINGS_APPROVAL checkbox list and waits for a yes/no per item.
 */
export const AUTO_FIX_CATEGORIES: FindingCategory[] = ["readability", "simplification"];

export const isAutoFixCategory = (category: FindingCategory): boolean =>
  AUTO_FIX_CATEGORIES.includes(category);

/**
 * FINDINGS_APPROVAL answer codec. The UI sends the canonical form; email
 * replies are free text, so parsing accepts a bare list of numbers plus the
 * "all" / "none" words. Kept in lock-step with apps/runner/src/types.ts.
 */
export const FINDINGS_APPROVAL_NONE = "none";

export function encodeFindingSelection(approved: number[]): string {
  return `Fix: ${approved.length ? approved.join(", ") : FINDINGS_APPROVAL_NONE}`;
}

/** 1-based numbers of the gated findings the user approved, deduped and sorted. */
export function parseFindingSelection(answer: string, count: number): number[] {
  if (/\bnone\b|\bskip\b|\bno(ne|thing)?\b/i.test(answer) && !/\d/.test(answer)) return [];
  if (/\ball\b/i.test(answer) && !/\d/.test(answer)) {
    return Array.from({ length: count }, (_, i) => i + 1);
  }
  const picked = new Set<number>();
  for (const match of answer.matchAll(/\d+/g)) {
    const n = Number(match[0]);
    if (n >= 1 && n <= count) picked.add(n);
  }
  return [...picked].toSorted((a, b) => a - b);
}

/**
 * Whether a PLAN_APPROVAL answer approves the plan. "Approved, but also add X"
 * is not an approval — it carries instructions, and treating it as one would
 * drop them — so only a short reply that starts with "approve" and has no
 * "but" counts. Anything else is revision notes. Kept in lock-step with apps/runner/src/types.ts.
 */
export function isPlanApproval(answer: string): boolean {
  const text = answer.trim();
  return /^approved?\b/i.test(text) && !/\bbut\b/i.test(text) && text.split(/\s+/).length <= 6;
}

/** Cycle-cap question options — the answer endpoint switches on these prefixes. */
export const CYCLE_CAP_OPTION_CONTINUE = "Run another fix cycle";
export const CYCLE_CAP_OPTION_CANCEL = "Cancel the task";

/** Dependency-failed question options (§5 tick step 2). */
export const DEP_OPTION_PROCEED = "Proceed anyway";
export const DEP_OPTION_CANCEL = "Cancel the task";

/** Question.stageRunId value for questions created by the orchestrator (no real stage run). */
export const ORCHESTRATOR_STAGE_RUN_ID = "orchestrator";

export const SETTING_DEFAULTS: Record<string, string> = {
  maxParallelTasks: "3",
  // Per-stage defaults: the judgment-heavy stages (planning, review) get the
  // most capable model, the high-volume ones get the cheaper Opus tier.
  defaultPlanningModel: "claude-fable-5-2",
  defaultImplementationModel: "claude-opus-5-5",
  defaultReviewModel: "claude-fable-5-2",
  defaultTestingModel: "claude-opus-5-5",
  models: JSON.stringify([
    "claude-fable-5-2",
    "claude-opus-5-5",
    "claude-sonnet-5-5",
    "claude-haiku-5-5",
  ]),
  containerMemGb: "16",
  containerCpus: "4",
  notifyOnDone: "true",
  notifyOnNeedsInput: "true",
  notifyOnFailed: "true",
  appUrl: process.env.APP_URL ?? "https://waypoint.ergh.co",
  // How an approved PR is merged: "merge" | "squash" | "rebase".
  prMergeMethod: "merge",
  // Comma-separated GitHub logins whose PR comments and approvals Waypoint acts
  // on. Empty = the owner of the GitHub PAT.
  prTrustedLogins: "",
  // Easy tasks go from plan straight to implementation without waiting for approval.
  autoApproveEasyPlans: "true",
};
