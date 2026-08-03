import type { Stage, TaskStatus } from "./generated/prisma/client";
import type { FindingCategory } from "./schemas";

/**
 * Statuses that count against Setting.maxParallelTasks (§5 tick step 3).
 * Single exported constant — the one source of truth for "task is occupying a slot".
 */
export const ACTIVE_STATUSES: TaskStatus[] = [
  "PLANNING",
  "AWAITING_PLAN_APPROVAL",
  "IMPLEMENTING",
  "REVIEWING",
  "TESTING",
  "NEEDS_INPUT",
  "RATE_LIMITED",
  "OPENING_PR",
];

/** Statuses in which the runner is (or should be) actively executing a stage. */
export const RUNNING_STAGE_STATUSES: TaskStatus[] = [
  "PLANNING",
  "IMPLEMENTING",
  "REVIEWING",
  "TESTING",
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
  defaultModel: "claude-fable-5",
  models: JSON.stringify(["claude-fable-5", "claude-opus-5", "claude-sonnet-5"]),
  containerMemGb: "16",
  containerCpus: "4",
  notifyOnDone: "true",
  notifyOnNeedsInput: "true",
  notifyOnFailed: "true",
  appUrl: process.env.APP_URL ?? "https://waypoint.ergh.co",
};
