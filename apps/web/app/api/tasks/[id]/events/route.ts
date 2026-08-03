import { type NextRequest, NextResponse } from "next/server";
import { db } from "@waypoint/core";
import { apiError, requireUser } from "@/lib/api";

/**
 * Event feed with a composite (createdAt, id) cursor (§3): uuid v4 ids don't
 * sort chronologically, so the client echoes back `?after={createdAtISO}_{id}`.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireUser();
    const { id } = await ctx.params;
    const after = req.nextUrl.searchParams.get("after");
    const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") ?? 200) || 200, 500);

    let cursorFilter = {};
    if (after) {
      const sep = after.lastIndexOf("_");
      const createdAt = new Date(after.slice(0, sep));
      const lastId = after.slice(sep + 1);
      if (!Number.isNaN(createdAt.getTime()) && lastId) {
        cursorFilter = {
          OR: [{ createdAt: { gt: createdAt } }, { createdAt, id: { gt: lastId } }],
        };
      }
    }

    const events = await db.event.findMany({
      where: { taskId: id, ...cursorFilter },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: limit,
    });

    const last = events[events.length - 1];
    return NextResponse.json({
      events: events.map((e) => ({
        id: e.id,
        type: e.type,
        stageRunId: e.stageRunId,
        payload: e.payload,
        createdAt: e.createdAt.toISOString(),
      })),
      cursor: last ? `${last.createdAt.toISOString()}_${last.id}` : (after ?? null),
    });
  } catch (err) {
    return apiError(err);
  }
}
