import { type NextRequest, NextResponse } from "next/server";
import { VERIFY_PROMPT_SENTINEL, db, getSetting } from "@waypoint/core";
import { ApiError, apiError, assertSameOrigin, requireUser } from "@/lib/api";

/**
 * "Verify" (§9): queue a throwaway container run that clones + runs
 * setupCommand + testCommand, streaming the log back as events on a synthetic
 * verify task. This is how you teach and validate a project.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(req);
    const user = await requireUser();
    const { id } = await ctx.params;
    const project = await db.project.findUnique({ where: { id } });
    if (!project) throw new ApiError(404, "project not found");

    const model = await getSetting("defaultModel");
    const task = await db.task.create({
      data: {
        projectId: id,
        title: `Verify: ${project.name}`,
        prompt: VERIFY_PROMPT_SENTINEL,
        difficulty: "EASY",
        planningModel: model,
        implementationModel: model,
        reviewModel: model,
        testingModel: model,
        createdById: user.id,
      },
    });
    return NextResponse.json({ taskId: task.id }, { status: 201 });
  } catch (err) {
    return apiError(err);
  }
}
