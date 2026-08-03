import { promises as fs } from "node:fs";
import { db, taskDataDir } from "@waypoint/core";
import { removeVolume, volumeName } from "./docker";

const LOG_RETENTION_DAYS = 30;
const WORKSPACE_RETENTION_DAYS = 7;

/**
 * Daily retention (§3.1): prune LOG events older than 30 days (everything else
 * is kept — it's small); delete expired workspace volumes + transcript files
 * past the 7-day window for DONE/CANCELLED tasks; PRAGMA optimize.
 */
export async function runRetention(): Promise<void> {
  console.log("[retention] running daily retention");

  const logCutoff = new Date(Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const pruned = await db.event.deleteMany({
    where: { type: "LOG", createdAt: { lt: logCutoff } },
  });
  if (pruned.count) console.log(`[retention] pruned ${pruned.count} LOG events`);

  const workspaceCutoff = new Date(Date.now() - WORKSPACE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const expired = await db.task.findMany({
    where: { status: { in: ["DONE", "CANCELLED"] }, endedAt: { lt: workspaceCutoff } },
  });
  for (const task of expired) {
    await removeVolume(volumeName(task.id));
    try {
      await fs.rm(taskDataDir(task.id), { recursive: true, force: true });
    } catch {
      /* already gone */
    }
  }
  if (expired.length) {
    console.log(`[retention] GC'd ${expired.length} expired workspaces/transcripts`);
  }

  await db.$queryRawUnsafe("PRAGMA optimize").catch(() => {});
}
