import { type NextRequest, NextResponse } from "next/server";
import { db, TestSuitesSchema } from "@waypoint/core";
import { z } from "zod";
import { apiError, assertSameOrigin, requireUser } from "@/lib/api";

export const ProjectBodySchema = z.object({
  name: z.string().min(1).max(100),
  repoUrl: z.string().url(),
  defaultBranch: z.string().min(1).default("main"),
  branchTemplate: z.string().min(1).default("eric/{id}"),
  setupCommand: z.string().min(1),
  runCommand: z.string().min(1),
  runReadyUrl: z.string().url().nullable().optional(),
  migrateCommand: z.string().nullable().optional(),
  testSuites: TestSuitesSchema.default([]),
  lintCommand: z.string().nullable().optional(),
  formatCommand: z.string().nullable().optional(),
  dockerfilePath: z.string().nullable().optional(),
  dockerEnabled: z.boolean().default(false),
  instructions: z.string().default(""),
});

export async function GET() {
  try {
    await requireUser();
    const projects = await db.project.findMany({
      orderBy: { name: "asc" },
      include: { _count: { select: { tasks: true } } },
    });
    return NextResponse.json({
      projects: projects.map((p) => ({
        id: p.id,
        name: p.name,
        repoUrl: p.repoUrl,
        defaultBranch: p.defaultBranch,
        taskCount: p._count.tasks,
      })),
    });
  } catch (err) {
    return apiError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req);
    await requireUser();
    const body = ProjectBodySchema.parse(await req.json());
    const project = await db.project.create({
      data: {
        ...body,
        runReadyUrl: body.runReadyUrl ?? null,
        migrateCommand: body.migrateCommand ?? null,
        testSuites: JSON.stringify(body.testSuites),
        lintCommand: body.lintCommand ?? null,
        formatCommand: body.formatCommand ?? null,
        dockerfilePath: body.dockerfilePath ?? null,
      },
    });
    return NextResponse.json({ id: project.id }, { status: 201 });
  } catch (err) {
    return apiError(err);
  }
}
