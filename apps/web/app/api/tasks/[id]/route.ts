import { type NextRequest, NextResponse } from "next/server";
import { STAGE_TO_STATUS, type TaskStatus, db, emitEvent, transition } from "@waypoint/core";
import { z } from "zod";
import { ApiError, apiError, assertSameOrigin, requireUser } from "@/lib/api";
import { getTaskDetail } from "@/lib/task-detail";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Params) {
  try {
    await requireUser();
    const { id } = await ctx.params;
    return NextResponse.json(await getTaskDetail(id));
  } catch (err) {
    return apiError(err);
  }
}

/** Statuses the "Start now" action accepts: a draft, or a task still behind a gate. */
const STARTABLE_STATUSES = new Set<TaskStatus>(["DRAFT", "SCHEDULED", "BLOCKED"]);

/** Statuses whose prompt can still be rewritten — nothing has run yet. */
const PROMPT_EDITABLE_STATUSES = new Set<TaskStatus>(["DRAFT", "SCHEDULED", "BLOCKED"]);

const PatchSchema = z.object({
  action: z.enum(["start", "pause", "resume", "stop", "cancel", "steer", "retry", "update_prompt"]),
  prompt: z.string().optional(),
});

export async function PATCH(req: NextRequest, ctx: Params) {
  try {
    assertSameOrigin(req);
    await requireUser();
    const { id } = await ctx.params;
    const { action, prompt } = PatchSchema.parse(await req.json());
    const task = await db.task.findUnique({ where: { id } });
    if (!task) throw new ApiError(404, "task not found");

    switch (action) {
      case "start": {
        // The manual start for a draft, and the force-start for a task still
        // sitting behind its time/dependency gate. Queuing is all it does — the
        // next orchestrator tick picks the task up like any other QUEUED row.
        // scheduledAt / dependsOnTaskId stay on the row as a record of intent;
        // promoteScheduled/promoteBlocked filter on status, so neither re-fires.
        if (!STARTABLE_STATUSES.has(task.status)) {
          throw new ApiError(409, `cannot start a task that is ${task.status}`);
        }
        await transition(id, "QUEUED", { reason: "started by user" });
        break;
      }
      case "pause": {
        await transition(id, "PAUSED", { pauseReason: "USER", reason: "paused by user" });
        break;
      }
      case "resume": {
        if (task.status !== "PAUSED" && task.status !== "RATE_LIMITED") {
          throw new ApiError(409, `cannot resume from ${task.status}`);
        }
        await transition(id, await resumeTarget(id), { pauseReason: null });
        break;
      }
      case "stop":
      case "cancel": {
        await transition(id, "CANCELLED", { reason: `${action} requested by user` });
        break;
      }
      case "steer": {
        if (!prompt?.trim()) throw new ApiError(400, "steer requires a prompt");
        await db.steeringMessage.create({ data: { taskId: id, text: prompt.trim() } });
        await emitEvent(id, "STEER", { text: prompt.trim() });
        break;
      }
      case "update_prompt": {
        // Rewriting the row is the whole job: a pre-start task has no container
        // and no session, and the orchestrator reads Task.prompt when it builds
        // TASK_META. The status doesn't change, so this never calls transition().
        const next = prompt?.trim();
        if (!next) throw new ApiError(400, "update_prompt requires a prompt");
        if (!PROMPT_EDITABLE_STATUSES.has(task.status)) {
          throw new ApiError(409, `cannot edit the prompt of a task that is ${task.status}`);
        }
        if (next !== task.prompt) {
          await db.task.update({ where: { id }, data: { prompt: next } });
          await emitEvent(id, "PROMPT_UPDATED", {});
        }
        break;
      }
      case "retry": {
        if (task.status !== "FAILED") throw new ApiError(409, "retry only applies to FAILED tasks");
        const revised = prompt?.trim();
        // The retry dialog sends the (possibly edited) task prompt. Rewriting
        // Task.prompt is what makes the revision stick: the orchestrator reads
        // it when it recreates the container. A steering message covers the
        // case where the existing session is resumed rather than rebuilt.
        if (revised && revised !== task.prompt) {
          await db.task.update({ where: { id }, data: { prompt: revised } });
          await db.steeringMessage.create({
            data: { taskId: id, text: `The task prompt was revised for this retry:\n\n${revised}` },
          });
          await emitEvent(id, "STEER", { text: "task prompt revised on retry" });
        }
        await transition(id, await resumeTarget(id), {
          failureCode: null,
          failureDetail: null,
          reason: "retry requested",
        });
        break;
      }
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}

/** Where a paused/rate-limited/failed task should go back to. */
async function resumeTarget(taskId: string) {
  const task = await db.task.findUniqueOrThrow({ where: { id: taskId } });
  const openQuestion = await db.question.findFirst({
    where: { taskId, status: "OPEN" },
    orderBy: { createdAt: "desc" },
  });
  if (openQuestion?.kind === "PLAN_APPROVAL") return "AWAITING_PLAN_APPROVAL" as const;
  if (openQuestion) return "NEEDS_INPUT" as const;
  if (task.currentStage) return STAGE_TO_STATUS[task.currentStage];
  return "QUEUED" as const;
}
