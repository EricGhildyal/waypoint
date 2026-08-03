import { db } from "@waypoint/core";

/**
 * Container healthcheck (§11): the orchestrator writes an orchestratorHeartbeat
 * Setting each tick; this script exits non-zero when it goes stale.
 */
const STALE_MS = 90_000;

async function main(): Promise<void> {
  const row = await db.setting.findUnique({ where: { key: "orchestratorHeartbeat" } });
  if (!row) throw new Error("no heartbeat yet");
  const age = Date.now() - new Date(row.value).getTime();
  if (Number.isNaN(age) || age > STALE_MS) {
    throw new Error(`heartbeat stale (${Math.round(age / 1000)}s)`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(String(err));
    process.exit(1);
  });
