import {
  ACTIVE_STATUSES,
  DEP_OPTION_CANCEL,
  DEP_OPTION_PROCEED,
  IDLE_STATUSES,
  ORCHESTRATOR_STAGE_RUN_ID,
  RUNNING_STAGE_STATUSES,
  STAGE_TO_STATUS,
  db,
  emitEvent,
  getNumberSetting,
  getSetting,
  transition,
} from "@waypoint/core";
import {
  isContainerRunning,
  listTaskContainers,
  recreateTaskContainer,
  removeContainer,
  startExistingContainer,
  startTask,
  stopContainer,
} from "./docker";
import { dispatchEmails } from "./email";
import { openPendingPrs } from "./pr";
import { runRetention } from "./retention";

const IDLE_STOP_MS = 15 * 60 * 1000;
const HEARTBEAT_LOST_MS = 5 * 60 * 1000;

/** consecutive heartbeat losses per task (in-memory; §5 step 6) */
const heartbeatLosses = new Map<string, number>();
let lastRetentionDay = "";
/** the rate-limit window fillSlots has already logged about (log once per window) */
let rateLimitLoggedFor = 0;

/** One idempotent tick (§5). Runs every 15s, concurrency-never (guarded in index.ts). */
export async function tick(): Promise<void> {
  await promoteScheduled();
  await promoteBlocked();
  await fillSlots();
  await stopIdleContainers();
  await resumeRateLimited();
  await detectHeartbeatLoss();
  await reconcile();
  await openPendingPrs();
  await dispatchEmails();
  await maybeDailyRetention();
}

/** 1. SCHEDULED → QUEUED where scheduledAt <= now. */
async function promoteScheduled(): Promise<void> {
  const due = await db.task.findMany({
    where: { status: "SCHEDULED", scheduledAt: { lte: new Date() } },
  });
  for (const task of due) {
    await transition(task.id, "QUEUED", { reason: "scheduled time reached" });
  }
}

/** 2. BLOCKED → QUEUED when the dependency is DONE; FAILED/CANCELLED dep → NEEDS_INPUT. */
async function promoteBlocked(): Promise<void> {
  const blocked = await db.task.findMany({
    where: { status: "BLOCKED" },
    include: { dependsOn: true },
  });
  for (const task of blocked) {
    const dep = task.dependsOn;
    if (!dep) {
      await transition(task.id, "QUEUED", { reason: "dependency missing" });
      continue;
    }
    if (dep.status === "DONE") {
      await transition(task.id, "QUEUED", { reason: `dependency ${dep.id} done` });
    } else if (dep.status === "FAILED" || dep.status === "CANCELLED") {
      const q = await db.question.create({
        data: {
          taskId: task.id,
          stageRunId: ORCHESTRATOR_STAGE_RUN_ID,
          kind: "QUESTION",
          text: `The task this one depends on ("${dep.title}") ended ${dep.status}. Proceed anyway, or cancel?`,
          contextSummary: `Dependency "${dep.title}" ended ${dep.status}.`,
          options: [DEP_OPTION_PROCEED, DEP_OPTION_CANCEL],
        },
      });
      await emitEvent(task.id, "QUESTION", { questionId: q.id });
      await transition(task.id, "NEEDS_INPUT", { reason: `dependency ${dep.status}` });
    }
  }
}

/** 3. Start the oldest QUEUED tasks while there are free slots. */
async function fillSlots(): Promise<void> {
  // Every task shares the one Claude Max window (§5) — starting a container
  // into an exhausted one just burns a slot to hit the same wall.
  const resetsAt = Date.parse(await getSetting("rateLimitResetsAt"));
  if (Number.isFinite(resetsAt) && resetsAt > Date.now()) {
    if (rateLimitLoggedFor !== resetsAt) {
      rateLimitLoggedFor = resetsAt;
      console.log(
        `[tick] Claude usage limit — holding QUEUED tasks until ${new Date(resetsAt).toISOString()}`,
      );
    }
    return;
  }

  const max = await getNumberSetting("maxParallelTasks");
  const active = await db.task.count({ where: { status: { in: ACTIVE_STATUSES } } });
  let free = max - active;
  if (free <= 0) return;

  const queued = await db.task.findMany({
    where: { status: "QUEUED" },
    orderBy: { createdAt: "asc" },
    take: free,
  });
  for (const task of queued) {
    await startTask(task.id);
    free--;
    if (free <= 0) break;
  }
}

/**
 * 4. Stop containers idle >15 min in waiting states (workspace volume
 * persists). "Idle" is measured from when the task ENTERED the waiting status
 * (its latest STATUS_CHANGE event) — the runner keeps heartbeating while
 * paused, so Task.updatedAt is not a usable idle signal.
 */
async function stopIdleContainers(): Promise<void> {
  const cutoff = new Date(Date.now() - IDLE_STOP_MS);
  const idle = await db.task.findMany({
    where: { status: { in: IDLE_STATUSES }, containerId: { not: null } },
  });
  for (const task of idle) {
    const lastChange = await db.event.findFirst({
      where: { taskId: task.id, type: "STATUS_CHANGE" },
      orderBy: { createdAt: "desc" },
    });
    if (lastChange && lastChange.createdAt > cutoff) continue; // not idle long enough
    if (task.containerId && (await isContainerRunning(task.containerId))) {
      console.log(`[tick] stopping idle container for task ${task.id} (${task.status})`);
      await stopContainer(task.containerId);
    }
  }
}

/** 5. Resume RATE_LIMITED tasks whose resetsAt passed (stored on the STATUS_CHANGE reason). */
async function resumeRateLimited(): Promise<void> {
  const limited = await db.task.findMany({ where: { status: "RATE_LIMITED" } });
  for (const task of limited) {
    const change = await db.event.findFirst({
      where: { taskId: task.id, type: "STATUS_CHANGE" },
      orderBy: { createdAt: "desc" },
    });
    const reason = (change?.payload as { reason?: string } | null)?.reason;
    const resetsAt = reason ? new Date(reason) : null;
    if (!resetsAt || Number.isNaN(resetsAt.getTime()) || resetsAt.getTime() <= Date.now()) {
      const target = task.currentStage ? STAGE_TO_STATUS[task.currentStage] : "PLANNING";
      console.log(`[tick] rate-limit window passed for task ${task.id} — resuming`);
      await transition(task.id, target, { reason: "rate-limit window reset" });
    }
  }
}

/**
 * 6. Heartbeat: no sync for 5 min while in a running stage → restart the stage
 * (the runner resumes its session from its state file); after 2 consecutive
 * losses → FAILED/RUNNER_CRASH.
 */
async function detectHeartbeatLoss(): Promise<void> {
  const cutoff = new Date(Date.now() - HEARTBEAT_LOST_MS);
  const stale = await db.task.findMany({
    where: {
      status: { in: RUNNING_STAGE_STATUSES },
      updatedAt: { lt: cutoff },
      containerId: { not: null },
    },
  });
  const staleIds = new Set(stale.map((t) => t.id));
  // Deleting the key currently being visited is well-defined for a Map
  // iterator, so this drops entries in place without a snapshot copy.
  for (const key of heartbeatLosses.keys()) {
    if (!staleIds.has(key)) heartbeatLosses.delete(key);
  }

  for (const task of stale) {
    const losses = (heartbeatLosses.get(task.id) ?? 0) + 1;
    heartbeatLosses.set(task.id, losses);
    console.warn(`[tick] heartbeat lost for task ${task.id} (count ${losses})`);

    if (losses >= 2) {
      await emitEvent(task.id, "ERROR", {
        code: "RUNNER_CRASH",
        message: "runner heartbeat lost twice in a row",
      });
      await transition(task.id, "FAILED", {
        failureCode: "RUNNER_CRASH",
        failureDetail: "No sync from the runner after a restart — inspect the container over SSH.",
      });
      if (task.containerId) await stopContainer(task.containerId);
      heartbeatLosses.delete(task.id);
      continue;
    }

    // first loss: restart the container; the runner resumes from /workspace state
    await emitEvent(task.id, "LOG", {
      level: "warn",
      line: "heartbeat lost — restarting the stage (session resumes)",
    });
    if (task.containerId) {
      await stopContainer(task.containerId);
      const started = await startExistingContainer(task.containerId);
      if (!started) {
        try {
          await recreateTaskContainer(task.id);
        } catch (err) {
          await failRecreate(task.id, err);
        }
      }
    }
    await db.task.update({ where: { id: task.id }, data: { updatedAt: new Date() } });
  }
}

/**
 * 7. Reconciliation (also on boot): diff labeled containers against DB state —
 * restart/recreate missing ones for active tasks, remove orphans whose task is
 * terminal (§5). FAILED tasks keep their stopped container + volume for SSH
 * inspection until retried or cancelled.
 */
export async function reconcile(): Promise<void> {
  const containers = await listTaskContainers();
  const byTask = new Map(containers.map((c) => [c.taskId, c]));

  // running-status tasks must have a running container
  const shouldRun = await db.task.findMany({
    where: { status: { in: RUNNING_STAGE_STATUSES } },
  });
  for (const task of shouldRun) {
    const container = byTask.get(task.id);
    if (container?.running) continue;
    if (container) {
      const ok = await startExistingContainer(container.id);
      if (ok) {
        await db.task.update({
          where: { id: task.id },
          data: { containerId: container.id, updatedAt: new Date() },
        });
        continue;
      }
      await removeContainer(container.id);
    }
    try {
      console.log(`[tick] reconcile: recreating container for task ${task.id}`);
      await recreateTaskContainer(task.id);
      await db.task.update({ where: { id: task.id }, data: { updatedAt: new Date() } });
    } catch (err) {
      await failRecreate(task.id, err);
    }
  }

  // orphan containers whose task is terminal (keep FAILED ones, stopped)
  for (const container of containers) {
    if (!container.taskId) continue;
    const task = await db.task.findUnique({ where: { id: container.taskId } });
    if (!task) {
      await removeContainer(container.id);
      continue;
    }
    if (task.status === "DONE" || task.status === "CANCELLED") {
      console.log(`[tick] teardown: removing container of ${task.status} task ${task.id}`);
      await removeContainer(container.id);
      if (task.containerId === container.id) {
        await db.task.update({ where: { id: task.id }, data: { containerId: null } });
      }
    } else if (task.status === "FAILED" && container.running) {
      await stopContainer(container.id); // kept, but stopped
    }
  }
}

async function failRecreate(taskId: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[tick] recreate failed for task ${taskId}: ${message}`);
  await emitEvent(taskId, "ERROR", { code: "DOCKER_CREATE", message: message.slice(0, 2000) });
  try {
    await transition(taskId, "FAILED", {
      failureCode: "DOCKER_CREATE",
      failureDetail: message.slice(0, 2000),
    });
  } catch {
    /* already terminal */
  }
}

/** 8. Slow daily branch: retention/GC + PRAGMA optimize (§3.1). */
async function maybeDailyRetention(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  if (today === lastRetentionDay) return;
  lastRetentionDay = today;
  await runRetention();
}
