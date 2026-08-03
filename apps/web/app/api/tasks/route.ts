import { type NextRequest, NextResponse } from "next/server";
import { db, getSetting, transition } from "@waypoint/core";
import { z } from "zod";
import { ApiError, apiError, assertSameOrigin, requireUser } from "@/lib/api";
import { getTaskList } from "@/lib/task-list";

/** GET doubles as the dashboard poll (§10). */
export async function GET(req: NextRequest) {
  try {
    await requireUser();
    const status = req.nextUrl.searchParams.get("status") ?? undefined;
    const projectId = req.nextUrl.searchParams.get("project") ?? undefined;
    return NextResponse.json(await getTaskList({ status, projectId }));
  } catch (err) {
    return apiError(err);
  }
}

const CreateTaskSchema = z.object({
  projectId: z.string(),
  title: z.string().min(1).max(200),
  prompt: z.string().min(1),
  difficulty: z.enum(["EASY", "MEDIUM", "HARD"]),
  models: z
    .object({
      planning: z.string().optional(),
      implementation: z.string().optional(),
      review: z.string().optional(),
      testing: z.string().optional(),
    })
    .optional(),
  scheduledAt: z.string().datetime({ offset: true }).nullable().optional(),
  dependsOnTaskId: z.string().nullable().optional(),
  tokenBudget: z.number().int().positive().nullable().optional(),
});

export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req);
    const user = await requireUser();
    const body = CreateTaskSchema.parse(await req.json());

    const project = await db.project.findUnique({ where: { id: body.projectId } });
    if (!project) throw new ApiError(404, "project not found");

    let dependsOn = null;
    if (body.dependsOnTaskId) {
      dependsOn = await db.task.findUnique({ where: { id: body.dependsOnTaskId } });
      if (!dependsOn) throw new ApiError(404, "dependency task not found");
    }

    const defaultModel = await getSetting("defaultModel");
    const task = await db.task.create({
      data: {
        projectId: body.projectId,
        title: body.title,
        prompt: body.prompt,
        difficulty: body.difficulty,
        planningModel: body.models?.planning || defaultModel,
        implementationModel: body.models?.implementation || defaultModel,
        reviewModel: body.models?.review || defaultModel,
        testingModel: body.models?.testing || defaultModel,
        scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : null,
        dependsOnTaskId: body.dependsOnTaskId ?? null,
        tokenBudget: body.tokenBudget ?? null,
        createdById: user.id,
      },
    });

    // tasks are born QUEUED; scheduling / dependency gating are transitions
    if (task.scheduledAt && task.scheduledAt.getTime() > Date.now()) {
      await transition(task.id, "SCHEDULED", {
        reason: `scheduled for ${task.scheduledAt.toISOString()}`,
      });
    } else if (dependsOn && dependsOn.status !== "DONE") {
      await transition(task.id, "BLOCKED", { reason: `waiting on task ${dependsOn.id}` });
    }

    return NextResponse.json({ id: task.id }, { status: 201 });
  } catch (err) {
    return apiError(err);
  }
}
