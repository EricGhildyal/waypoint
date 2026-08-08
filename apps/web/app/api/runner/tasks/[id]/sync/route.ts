import { createHash, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import { type NextRequest, NextResponse } from "next/server";
import {
  ALLOWED_TRANSITIONS,
  CYCLE_CAP_OPTION_CONTINUE,
  EVENT_PAYLOAD_SCHEMAS,
  FindingsSchema,
  RUNNING_STAGE_STATUSES,
  STAGE_TO_STATUS,
  SyncRequestSchema,
  TERMINAL_STATUSES,
  VERIFY_PROMPT_SENTINEL,
  artifactDir,
  artifactPath,
  db,
  emitEvent,
  isAutoFixCategory,
  recordUsageWindows,
  setSetting,
  transcriptPath,
  transition,
} from "@waypoint/core";
import type {
  FailureCode,
  InboxItem,
  Stage,
  SyncRequest,
  SyncResponse,
  Task,
} from "@waypoint/core";

const FAILURE_CODES: FailureCode[] = [
  "DOCKER_CREATE",
  "DOCKER_START",
  "GIT_CLONE",
  "SETUP_COMMAND",
  "RUNNER_CRASH",
  "HEARTBEAT_LOST",
  "PUSH_FAILED",
  "PR_FAILED",
];

/**
 * POST /api/runner/tasks/{id}/sync — the runner's ONLY endpoint (§6).
 * Bearer = Task.runnerToken (constant-time compare, valid only while the task
 * is non-terminal; FAILED keeps it valid for Retry). Doubles as the heartbeat.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const task = await db.task.findUnique({ where: { id }, include: { project: true } });

  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!task || !safeEqual(token, task.runnerToken)) {
    return new NextResponse(null, { status: 401 });
  }
  if (task.status === "DONE" || task.status === "CANCELLED") {
    return NextResponse.json({ inbox: [], control: "stop" } satisfies SyncResponse);
  }

  let body: SyncRequest;
  try {
    body = SyncRequestSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "invalid sync payload" }, { status: 400 });
  }

  const isVerify = task.prompt === VERIFY_PROMPT_SENTINEL;

  // Heartbeat: the orchestrator detects missed heartbeats from updatedAt staleness.
  await db.task.update({ where: { id }, data: { updatedAt: new Date() } });

  if (body.stage?.action === "start") await handleStageStart(task, body.stage, isVerify);

  for (const ev of body.events ?? []) {
    // dedicated sync fields own every other event type; the runner only emits logs/errors
    if (ev.type !== "LOG" && ev.type !== "ERROR") continue;
    const stageRunId = ev.stageRunId ? await resolveStageRunId(id, ev.stageRunId) : undefined;
    if (ev.type === "ERROR") {
      const payload = EVENT_PAYLOAD_SCHEMAS.ERROR.parse(ev.payload);
      await emitEvent(id, "ERROR", payload, stageRunId);
      if ((FAILURE_CODES as string[]).includes(payload.code)) {
        await safeTransition(id, "FAILED", {
          failureCode: payload.code as FailureCode,
          failureDetail: payload.message,
        });
      }
    } else {
      await emitEvent(id, "LOG", ev.payload, stageRunId);
    }
  }

  if (body.usage) await handleUsage(task, body.usage);

  if (body.checklist) {
    await db.task.update({ where: { id }, data: { checklist: body.checklist } });
    await emitEvent(id, "CHECKLIST_UPDATE", { items: body.checklist });
  }

  if (body.question) await handleQuestion(task, body.question);

  if (body.stage?.action === "end") await handleStageEnd(task, body.stage, isVerify);

  if (body.rateLimitWarning) {
    // approaching the window — display only (the yellow banner); nothing pauses
    await setSetting(
      "rateLimitWarning",
      JSON.stringify({ ...body.rateLimitWarning, reportedAt: new Date().toISOString() }),
    );
  }

  // latest utilization per Claude limit window — display only (settings bars)
  if (body.usageWindows?.length) await recordUsageWindows(body.usageWindows);

  if (body.rateLimit) {
    // every task shares the one Claude Max OAuth token (§5) — when one runner
    // hits the window, rate-limit ALL actively running tasks together; the
    // orchestrator resumes each at resetsAt via `resume: sessionId`
    const running = await db.task.findMany({
      where: { status: { in: RUNNING_STAGE_STATUSES } },
      select: { id: true },
    });
    for (const t of running) {
      await safeTransition(t.id, "RATE_LIMITED", { reason: body.rateLimit.resetsAt });
    }
    // global: feeds the banner and stops the orchestrator filling slots
    if (!Number.isNaN(Date.parse(body.rateLimit.resetsAt))) {
      await setSetting("rateLimitResetsAt", body.rateLimit.resetsAt);
    }
  }

  const inbox = await buildInbox(id, body.cursor);
  const fresh = await db.task.findUniqueOrThrow({ where: { id } });
  return NextResponse.json({ inbox, control: controlFor(fresh.status) } satisfies SyncResponse);
}

function controlFor(status: string): SyncResponse["control"] {
  if (status === "PAUSED" || status === "RATE_LIMITED") return "pause";
  if (
    status === "CANCELLED" ||
    status === "DONE" ||
    status === "FAILED" ||
    status === "OPENING_PR"
  ) {
    return "stop";
  }
  return "run";
}

type TaskWithProject = Task & { project: { name: string } };
type StageMsg = NonNullable<SyncRequest["stage"]>;

async function handleStageStart(
  task: TaskWithProject,
  stage: Extract<StageMsg, { action: "start" }>,
  isVerify: boolean,
) {
  const key = { taskId: task.id, stage: stage.stage, attempt: stage.attempt };
  const existing = await db.stageRun.findUnique({ where: { taskId_stage_attempt: key } });
  let run: { id: string };
  if (existing) {
    // idempotent re-send — the runner repeats the start once the session id is
    // known. A terminal task's runner can still sync (its token stays valid for
    // Retry), so only reopen the row while the task is still in flight —
    // otherwise the re-send would flip a closed-out run back into a spinner.
    run = await db.stageRun.update({
      where: { id: existing.id },
      data: {
        sessionId: stage.sessionId ?? existing.sessionId,
        ...(TERMINAL_STATUSES.includes(task.status)
          ? {}
          : { status: "RUNNING" as const, endedAt: null }),
      },
    });
  } else {
    run = await db.stageRun.create({
      data: {
        ...key,
        model: stage.model,
        sessionId: stage.sessionId ?? null,
        transcriptPath: transcriptPath(task.id, stage.stage, stage.attempt),
      },
    });
    await emitEvent(
      task.id,
      "STAGE_START",
      { stage: stage.stage, attempt: stage.attempt, model: stage.model },
      run.id,
    );
  }

  // A newer attempt starting proves any other still-RUNNING run on this task was
  // abandoned (heartbeat-loss restart, resume after a pause, retry) — close it
  // out so it stops spinning.
  await db.stageRun.updateMany({
    where: { taskId: task.id, status: "RUNNING", id: { not: run.id } },
    data: { status: "FAILED", endedAt: new Date() },
  });

  if (isVerify) return; // verify runs stay in PLANNING until the end

  const target = STAGE_TO_STATUS[stage.stage as Stage];
  const fresh = await db.task.findUniqueOrThrow({ where: { id: task.id } });
  if (fresh.status !== target && ALLOWED_TRANSITIONS[fresh.status].includes(target)) {
    await transition(task.id, target, { currentStage: stage.stage as Stage });
  } else if (fresh.currentStage !== stage.stage) {
    await db.task.update({ where: { id: task.id }, data: { currentStage: stage.stage as Stage } });
  }
}

async function handleStageEnd(
  task: TaskWithProject,
  stage: Extract<StageMsg, { action: "end" }>,
  isVerify: boolean,
) {
  const key = { taskId: task.id, stage: stage.stage, attempt: stage.attempt };
  const run = await db.stageRun.findUnique({ where: { taskId_stage_attempt: key } });
  if (!run) return;

  await db.stageRun.update({
    where: { id: run.id },
    data: {
      status: stage.status,
      sessionId: stage.sessionId ?? run.sessionId,
      endedAt: new Date(),
    },
  });
  await emitEvent(
    task.id,
    "STAGE_END",
    { stage: stage.stage, attempt: stage.attempt, status: stage.status },
    run.id,
  );

  // persist artifacts (plan.md, pr.md, findings JSONs) to the task-data volume
  if (stage.artifacts?.length) {
    await fs.mkdir(artifactDir(task.id), { recursive: true });
    for (const artifact of stage.artifacts) {
      await fs.writeFile(artifactPath(task.id, artifact.name), artifact.content, "utf8");
    }
  }

  if (isVerify && stage.stage === "PLANNING") {
    if (stage.status === "SUCCEEDED") {
      await safeTransition(task.id, "DONE", { reason: "verify run succeeded" });
    } else {
      await safeTransition(task.id, "FAILED", {
        failureCode: "SETUP_COMMAND",
        failureDetail: "Verify run failed — see the activity log",
      });
    }
    return;
  }

  if (stage.status !== "SUCCEEDED") return;

  if (stage.stage === "REVIEW" || stage.stage === "TESTING") {
    const isReview = stage.stage === "REVIEW";
    const artifact = stage.artifacts?.find((a) =>
      a.name.startsWith(isReview ? "review-findings" : "test-findings"),
    );
    let verdict: "approve" | "request_changes" = "approve";
    let count = 0;
    let needsApproval = false;
    if (artifact) {
      try {
        const findings = FindingsSchema.parse(JSON.parse(artifact.content));
        verdict = findings.verdict;
        count = findings.findings.length;
        // review only: anything outside readability/simplification waits for a
        // per-finding yes/no, so the runner asks before any fix round starts
        needsApproval = isReview && findings.findings.some((f) => !isAutoFixCategory(f.category));
      } catch {
        /* malformed findings — treat as approve */
      }
    }
    await emitEvent(
      task.id,
      isReview ? "REVIEW_FINDINGS" : "TEST_FINDINGS",
      { attempt: stage.attempt, verdict, count },
      run.id,
    );

    if (verdict === "request_changes") {
      await db.task.update({
        where: { id: task.id },
        data: isReview ? { reviewCycles: { increment: 1 } } : { testingCycles: { increment: 1 } },
      });
      if (needsApproval) {
        // stay in REVIEWING — the FINDINGS_APPROVAL question lands next sync and
        // flips this to NEEDS_INPUT; applyAnswer picks the stage to go to
        return;
      }
      // bounce back to implementation; if the cycle cap was hit the runner
      // follows up with a cycle-cap question that flips this to NEEDS_INPUT
      await safeTransition(task.id, "IMPLEMENTING", {
        currentStage: "IMPLEMENTATION",
        reason: `${stage.stage.toLowerCase()} requested changes (${count} findings)`,
      });
    } else if (isReview) {
      await safeTransition(task.id, "TESTING", { currentStage: "TESTING" });
    } else {
      // testing success — the runner has already pushed the branch (§7)
      await safeTransition(task.id, "OPENING_PR", { reason: "branch pushed" });
    }
  }
}

async function handleUsage(task: TaskWithProject, usage: NonNullable<SyncRequest["usage"]>) {
  const stageRunId = await resolveStageRunId(task.id, usage.stageRunId);
  if (!stageRunId) return;
  await db.stageRun.update({
    where: { id: stageRunId },
    data: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
    },
  });
  await emitEvent(task.id, "TOKEN_UPDATE", { ...usage, stageRunId }, stageRunId);

  if (task.tokenBudget) {
    const sums = await db.stageRun.aggregate({
      where: { taskId: task.id },
      _sum: {
        inputTokens: true,
        outputTokens: true,
        cacheReadTokens: true,
        cacheCreationTokens: true,
      },
    });
    const total =
      (sums._sum.inputTokens ?? 0) +
      (sums._sum.outputTokens ?? 0) +
      (sums._sum.cacheReadTokens ?? 0) +
      (sums._sum.cacheCreationTokens ?? 0);
    if (total > task.tokenBudget) {
      await safeTransition(task.id, "PAUSED", {
        pauseReason: "BUDGET_EXCEEDED",
        reason: `token budget exceeded (${total} > ${task.tokenBudget})`,
      });
    }
  }
}

async function handleQuestion(
  task: TaskWithProject,
  question: NonNullable<SyncRequest["question"]>,
) {
  // A container stopped while a question waits (§5 idle stop) resumes into the
  // same gate and re-sends the identical question — that is a re-send, not a
  // new question, and its answer is already on its way back via the inbox.
  const identical = await db.question.findFirst({
    where: { taskId: task.id, kind: question.kind, text: question.text },
  });
  if (identical) return;

  const open = await db.question.findFirst({ where: { taskId: task.id, status: "OPEN" } });
  if (open) return; // ≤1 open question at a time

  const run = await db.stageRun.findFirst({
    where: { taskId: task.id },
    orderBy: { startedAt: "desc" },
  });
  const q = await db.question.create({
    data: {
      taskId: task.id,
      stageRunId: run?.id ?? "runner",
      kind: question.kind,
      text: question.text,
      contextSummary: question.contextSummary,
      options: question.options ?? undefined,
      items: question.items ?? undefined,
    },
  });
  await emitEvent(task.id, "QUESTION", { questionId: q.id }, run?.id);

  if (question.kind === "PLAN_APPROVAL") {
    await safeTransition(task.id, "AWAITING_PLAN_APPROVAL", { reason: "plan ready for approval" });
  } else if (question.kind === "FINDINGS_APPROVAL") {
    await safeTransition(task.id, "NEEDS_INPUT", { reason: "review findings need approval" });
  } else {
    const isCycleCap = question.options?.includes(CYCLE_CAP_OPTION_CONTINUE) ?? false;
    await safeTransition(task.id, "NEEDS_INPUT", {
      pauseReason: isCycleCap ? "CYCLE_CAP" : undefined,
      reason: isCycleCap ? "cycle cap reached" : "agent question",
    });
  }
}

async function buildInbox(taskId: string, cursor: string | null): Promise<InboxItem[]> {
  const [steering, answered] = await Promise.all([
    db.steeringMessage.findMany({ where: { taskId }, orderBy: { createdAt: "asc" } }),
    db.question.findMany({
      where: { taskId, status: "ANSWERED" },
      orderBy: { answeredAt: "asc" },
    }),
  ]);

  type Keyed = { key: [number, string]; item: InboxItem; steeringId?: string };
  const items: Keyed[] = [
    ...steering.map((s) => ({
      key: [s.createdAt.getTime(), s.id] as [number, string],
      item: { id: s.id, type: "steering", text: s.text } as InboxItem,
      steeringId: s.id,
    })),
    ...answered.map((q) => ({
      key: [(q.answeredAt ?? q.createdAt).getTime(), q.id] as [number, string],
      item: {
        id: q.id,
        type: "answer",
        questionId: q.id,
        answer: q.answer ?? "",
      } as InboxItem,
    })),
  ].toSorted((a, b) =>
    a.key[0] === b.key[0] ? a.key[1].localeCompare(b.key[1]) : a.key[0] - b.key[0],
  );

  const cursorKey = cursor ? items.find((i) => i.item.id === cursor)?.key : undefined;
  const pending = cursorKey
    ? items.filter(
        (i) =>
          i.key[0] > cursorKey[0] ||
          (i.key[0] === cursorKey[0] && i.key[1].localeCompare(cursorKey[1]) > 0),
      )
    : items;
  const out = pending.slice(0, 20);

  const steeringIds = out.map((i) => i.steeringId).filter((v): v is string => Boolean(v));
  if (steeringIds.length) {
    await db.steeringMessage.updateMany({
      where: { id: { in: steeringIds }, deliveredAt: null },
      data: { deliveredAt: new Date() },
    });
  }
  return out.map((i) => i.item);
}

/** The runner references stage runs as "{STAGE}:{attempt}" (ids are server-side). */
async function resolveStageRunId(taskId: string, ref: string): Promise<string | undefined> {
  const match = /^(PLANNING|IMPLEMENTATION|REVIEW|TESTING):(\d+)$/.exec(ref);
  if (!match) {
    const run = await db.stageRun.findUnique({ where: { id: ref } });
    return run?.taskId === taskId ? run.id : undefined;
  }
  const run = await db.stageRun.findUnique({
    where: {
      taskId_stage_attempt: {
        taskId,
        stage: match[1] as Stage,
        attempt: Number(match[2]),
      },
    },
  });
  return run?.id;
}

/** Transition, ignoring moves the state machine disallows (stale runner syncs). */
async function safeTransition(
  taskId: string,
  to: Parameters<typeof transition>[1],
  meta?: Parameters<typeof transition>[2],
) {
  try {
    await transition(taskId, to, meta);
  } catch {
    /* stale/racing sync — keep the current status */
  }
}

function safeEqual(a: string, b: string): boolean {
  const da = createHash("sha256").update(a).digest();
  const db_ = createHash("sha256").update(b).digest();
  return timingSafeEqual(da, db_);
}
