import {
  CYCLE_CAP_OPTION_CANCEL,
  CYCLE_CAP_OPTION_CONTINUE,
  DEP_OPTION_CANCEL,
  STAGE_TO_STATUS,
  db,
  emitEvent,
  parseFindingSelection,
  transition,
} from "@waypoint/core";
import type { AnsweredVia, FindingApprovalItem } from "@waypoint/core";
import { ApiError } from "./api";

/**
 * Record an answer to a Question and move the task on — shared by the UI
 * answer endpoint and the Resend inbound webhook (§8): this is also how plans
 * are approved.
 */
export async function applyAnswer(
  taskId: string,
  questionId: string,
  answerText: string,
  via: AnsweredVia,
): Promise<void> {
  const question = await db.question.findUnique({ where: { id: questionId } });
  if (!question || question.taskId !== taskId) throw new ApiError(404, "question not found");
  if (question.status !== "OPEN") throw new ApiError(409, "question already answered");

  const answer = answerText.trim();
  if (!answer) throw new ApiError(400, "empty answer");

  await db.question.update({
    where: { id: questionId },
    data: { status: "ANSWERED", answer, answeredVia: via, answeredAt: new Date() },
  });
  await emitEvent(taskId, "ANSWER", { questionId, via }, question.stageRunId);

  const task = await db.task.findUniqueOrThrow({ where: { id: taskId } });
  const options = (question.options as string[] | null) ?? [];
  const cancels =
    (options.includes(CYCLE_CAP_OPTION_CANCEL) || options.includes(DEP_OPTION_CANCEL)) &&
    /^cancel/i.test(answer);

  if (question.kind === "PLAN_APPROVAL") {
    if (task.status !== "AWAITING_PLAN_APPROVAL") return; // paused/cancelled meanwhile
    if (/^approve/i.test(answer)) {
      await transition(taskId, "IMPLEMENTING", { currentStage: "IMPLEMENTATION" });
    } else {
      // any other reply is treated as revision notes — planning resumes (attempt++)
      await transition(taskId, "PLANNING", { currentStage: "PLANNING" });
    }
    return;
  }

  if (task.status !== "NEEDS_INPUT") return;

  if (question.kind === "FINDINGS_APPROVAL") {
    // Mirror the runner's own read of the answer: approved findings (plus any
    // auto-fixed ones) mean a fix round, nothing to fix means straight to testing.
    const items = (question.items as FindingApprovalItem[] | null) ?? [];
    const gated = items.filter((i) => !i.auto);
    const approved = parseFindingSelection(answer, gated.length);
    const fixCount = approved.length + items.filter((i) => i.auto).length;
    if (fixCount > 0) {
      await transition(taskId, "IMPLEMENTING", {
        currentStage: "IMPLEMENTATION",
        pauseReason: null,
        reason: `${approved.length}/${gated.length} review findings approved`,
      });
    } else {
      await transition(taskId, "TESTING", {
        currentStage: "TESTING",
        pauseReason: null,
        reason: "no review findings approved",
      });
    }
    return;
  }

  if (cancels) {
    await transition(taskId, "CANCELLED", { reason: "user chose to cancel", pauseReason: null });
    return;
  }

  if (options.includes(CYCLE_CAP_OPTION_CONTINUE) && /^run another/i.test(answer)) {
    // cycle-cap resolution: run one more implementation fix round
    await transition(taskId, "IMPLEMENTING", {
      currentStage: "IMPLEMENTATION",
      pauseReason: null,
    });
    return;
  }

  if (task.currentStage) {
    await transition(taskId, STAGE_TO_STATUS[task.currentStage], { pauseReason: null });
  } else {
    // dependency-failed proceed-anyway question (task never started)
    await transition(taskId, "QUEUED", { pauseReason: null });
  }
}
