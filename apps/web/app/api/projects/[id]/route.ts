import { type NextRequest, NextResponse } from "next/server";
import { db } from "@waypoint/core";
import { ApiError, apiError, assertSameOrigin, requireUser } from "@/lib/api";
import { ProjectBodySchema } from "../route";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Params) {
  try {
    await requireUser();
    const { id } = await ctx.params;
    const project = await db.project.findUnique({
      where: { id },
      include: { secrets: { select: { key: true } } },
    });
    if (!project) throw new ApiError(404, "project not found");
    const { secrets, ...fields } = project;
    return NextResponse.json({
      ...fields,
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
      // write-only display: name + "set" indicator, never echo values (§9)
      secrets: secrets.map((s) => ({ key: s.key, set: true })),
    });
  } catch (err) {
    return apiError(err);
  }
}

export async function PATCH(req: NextRequest, ctx: Params) {
  try {
    assertSameOrigin(req);
    await requireUser();
    const { id } = await ctx.params;
    const body = ProjectBodySchema.partial().parse(await req.json());
    const project = await db.project.update({ where: { id }, data: body });
    return NextResponse.json({ id: project.id });
  } catch (err) {
    return apiError(err);
  }
}

export async function DELETE(req: NextRequest, ctx: Params) {
  try {
    assertSameOrigin(req);
    await requireUser();
    const { id } = await ctx.params;
    const taskCount = await db.task.count({ where: { projectId: id } });
    if (taskCount > 0) {
      throw new ApiError(409, "project has tasks — cancel/delete them first");
    }
    await db.project.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
