import { setSetting } from "@waypoint/core";
import { reconcile, tick } from "./tick";

/**
 * The orchestrator (§5): a single Node process. Main loop = plain setInterval
 * every 15s — no cron library. Each tick is idempotent; a simple in-process
 * `running` flag guarantees concurrently-never.
 */
const TICK_MS = 15_000;
let running = false;
let stopping = false;

async function runTick(): Promise<void> {
  if (running || stopping) return;
  running = true;
  try {
    await tick();
    // heartbeat Setting row — the container healthcheck reads this (§11)
    await setSetting("orchestratorHeartbeat", new Date().toISOString());
  } catch (err) {
    console.error("[orchestrator] tick failed:", err);
  } finally {
    running = false;
  }
}

async function main(): Promise<void> {
  console.log("[orchestrator] starting — boot reconciliation first");
  try {
    await reconcile();
  } catch (err) {
    console.error("[orchestrator] boot reconciliation failed:", err);
  }

  await runTick();
  const timer = setInterval(runTick, TICK_MS);

  const shutdown = () => {
    console.log("[orchestrator] shutting down");
    stopping = true;
    clearInterval(timer);
    // let an in-flight tick finish, then exit
    const wait = setInterval(() => {
      if (!running) {
        clearInterval(wait);
        process.exit(0);
      }
    }, 250);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

void main();
