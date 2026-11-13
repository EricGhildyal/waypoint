import { type NextRequest, NextResponse } from "next/server";
import { db, parseTestSuites } from "@waypoint/core";
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
      testSuites: parseTestSuites(project.testSuites),
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
    const raw: unknown = await req.json();
    const parsed = ProjectBodySchema.partial().parse(raw);
    // .partial() still fills in schema defaults, so a field the caller left
    // out would be reset to its default. Keep only what was actually sent.
    const sent = raw && typeof raw === "object" ? raw : {};
    const body = Object.fromEntries(
      Object.entries(parsed).filter(([key]) => Object.hasOwn(sent, key)),
    );
    if (!(await db.project.findUnique({ where: { id }, select: { id: true } }))) {
      throw new ApiError(404, "project not found");
    }
    const project = await db.project.update({
      where: { id },
      data: {
        ...body,
        // stored as JSON text
        ...(parsed.testSuites && Object.hasOwn(sent, "testSuites")
          ? { testSuites: JSON.stringify(parsed.testSuites) }
          : {}),
      },
    });
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
