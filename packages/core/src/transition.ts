import { db } from "./db";
import type { FailureCode, PauseReason, Stage, Task, TaskStatus } from "./generated/prisma/client";

/**
 * The static transition map (§5). Every status change in the entire system goes
 * through transition() below — web route handlers, the runner sync endpoint and
 * the orchestrator all share this single write path.
 */
export const ALLOWED_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  QUEUED: ["SCHEDULED", "BLOCKED", "PLANNING", "CANCELLED", "FAILED"],
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
    "NEEDS_INPUT",
    "FAILED",
    "CANCELLED",
  ],
  RATE_LIMITED: [
    "PLANNING",
    "IMPLEMENTING",
    "REVIEWING",
    "TESTING",
    "PAUSED",
    "FAILED",
    "CANCELLED",
  ],
  OPENING_PR: ["DONE", "FAILED", "CANCELLED"],
  FAILED: [
    // Retry resumes the failed stage (or re-queues when it never started)
    "QUEUED",
    "PLANNING",
    "AWAITING_PLAN_APPROVAL",
    "IMPLEMENTING",
    "REVIEWING",
    "TESTING",
    "OPENING_PR",
    "CANCELLED",
  ],
  DONE: [],
  CANCELLED: [],
};

export class TransitionError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly from: TaskStatus,
    public readonly to: TaskStatus,
  ) {
    super(`Invalid transition ${from} -> ${to} for task ${taskId}`);
  }
}

export interface TransitionMeta {
  /** Free-text reason recorded on the STATUS_CHANGE event (e.g. rate-limit resetsAt ISO). */
  reason?: string;
  pauseReason?: PauseReason | null;
  failureCode?: FailureCode | null;
  failureDetail?: string | null;
  currentStage?: Stage | null;
}

/**
 * Validate a status change against ALLOWED_TRANSITIONS, update the Task and
 * write the STATUS_CHANGE event in one $transaction (§2). Idempotent when the
 * task is already in the target status.
 */
export async function transition(
  taskId: string,
  to: TaskStatus,
  meta: TransitionMeta = {},
): Promise<Task> {
  return db.$transaction(async (tx) => {
    const task = await tx.task.findUniqueOrThrow({ where: { id: taskId } });
    if (task.status === to) return task;
    if (!ALLOWED_TRANSITIONS[task.status].includes(to)) {
      throw new TransitionError(taskId, task.status, to);
    }

    const terminal = to === "DONE" || to === "FAILED" || to === "CANCELLED";
    const updated = await tx.task.update({
      where: { id: taskId },
      data: {
        status: to,
        ...(meta.currentStage !== undefined ? { currentStage: meta.currentStage } : {}),
        // pause/failure annotations are cleared automatically when leaving those states
        pauseReason:
          meta.pauseReason !== undefined
            ? meta.pauseReason
            : to === "PAUSED" || to === "NEEDS_INPUT"
              ? task.pauseReason
              : null,
        failureCode:
          meta.failureCode !== undefined
            ? meta.failureCode
            : to === "FAILED"
              ? task.failureCode
              : null,
        failureDetail:
          meta.failureDetail !== undefined
            ? meta.failureDetail
            : to === "FAILED"
              ? task.failureDetail
              : null,
        ...(task.startedAt === null && to === "PLANNING" ? { startedAt: new Date() } : {}),
        ...(terminal ? { endedAt: new Date() } : {}),
      },
    });

    await tx.event.create({
      data: {
        taskId,
        type: "STATUS_CHANGE",
        payload: {
          from: task.status,
          to,
          ...(meta.reason ? { reason: meta.reason } : {}),
        },
      },
    });

    return updated;
  });
}
