import { promises as fs } from "node:fs";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "@waypoint/core";
import { ApiError, apiError, requireUser } from "@/lib/api";

/** Full transcripts are files on the task-data volume, not DB rows (§3). */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string; stageRunId: string }> },
) {
  try {
    await requireUser();
    const { id, stageRunId } = await ctx.params;
    const run = await db.stageRun.findUnique({ where: { id: stageRunId } });
    if (!run || run.taskId !== id || !run.transcriptPath) {
      throw new ApiError(404, "transcript not found");
    }
    try {
      const content = await fs.readFile(run.transcriptPath, "utf8");
      return new NextResponse(content, {
        headers: { "content-type": "application/jsonl; charset=utf-8" },
      });
    } catch {
      throw new ApiError(404, "transcript not found");
    }
  } catch (err) {
    return apiError(err);
  }
}
