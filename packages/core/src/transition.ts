import { ALLOWED_TRANSITIONS } from "./constants";
import { db } from "./db";
import type { FailureCode, PauseReason, Stage, Task, TaskStatus } from "./generated/prisma/client";

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

    if (terminal) {
      // A stage run still marked RUNNING when the task ends never reported a
      // stage end (crash, infra failure, heartbeat loss, cancel) — by definition
      // it did not finish, so close it out as a failure rather than leaving the
      // task page spinning forever.
      await tx.stageRun.updateMany({
        where: { taskId, status: "RUNNING" },
        data: { status: "FAILED", endedAt: new Date() },
      });
    }

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
