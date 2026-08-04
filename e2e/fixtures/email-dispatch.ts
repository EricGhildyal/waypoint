/**
 * Drives the orchestrator's REAL email dispatcher (`dispatchEmails()`) against a
 * fake Resend API and prints every captured outbound message as JSON.
 *
 * Nothing here is mocked except the Resend HTTP endpoint: the module under test
 * is imported unchanged and talks to it through the real `resend` SDK (which
 * honours RESEND_BASE_URL), so the assertions in `email-threading.spec.ts` see
 * the exact subject/headers/HTML that would hit Gmail.
 *
 * Run by the spec as a subprocess (like `reseed.ts`) so the Prisma client stays
 * out of the Playwright worker:
 *
 *   DATABASE_URL=file:$PWD/packages/core/prisma/dev.db bunx tsx e2e/fixtures/email-dispatch.ts
 *
 * stdout is a single JSON document between the BEGIN/END markers below.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { db } from "@waypoint/core/db";
import {
  EMAIL_FIXTURES,
  EMAIL_RECIPIENT,
  EMAIL_TITLES,
  INBOUND_DOMAIN,
  LEGACY_ROOT_MESSAGE_ID,
  PLAN_MARKDOWN,
  PLAN_WITH_RAW_HTML,
  REPORT_BEGIN,
  REPORT_END,
} from "./email-ids";

interface CapturedEmail {
  step: string;
  to: string[];
  from: string;
  subject: string;
  html: string;
  replyTo?: string;
  headers: Record<string, string>;
}

const MODELS = {
  planningModel: "claude-fable-5",
  implementationModel: "claude-fable-5",
  reviewModel: "claude-fable-5",
  testingModel: "claude-fable-5",
};

const TASK_IDS = [
  EMAIL_FIXTURES.threadTaskId,
  EMAIL_FIXTURES.statusRootTaskId,
  EMAIL_FIXTURES.legacyTaskId,
  EMAIL_FIXTURES.sameTickTaskId,
  EMAIL_FIXTURES.sendFailTaskId,
  EMAIL_FIXTURES.planHtmlTaskId,
];

/** Everything the spec asserts on, keyed by fixture. */
interface Report {
  emails: CapturedEmail[];
  tasks: Record<string, string | null>;
  questions: Record<string, string | null>;
}

async function main(): Promise<void> {
  const captured: CapturedEmail[] = [];
  let step = "setup";

  // ---- fake Resend -------------------------------------------------------
  // Rejects the send-failure fixture (so we can assert no root is persisted),
  // accepts everything else with a Resend-shaped 200.
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const payload = JSON.parse(body || "{}") as {
        to: string[];
        from: string;
        subject: string;
        html: string;
        reply_to?: string;
        replyTo?: string;
        headers?: Record<string, string>;
      };
      if (payload.subject.includes(EMAIL_TITLES.sendFail)) {
        res.writeHead(422, { "content-type": "application/json" });
        res.end(JSON.stringify({ name: "validation_error", message: "fake rejection" }));
        return;
      }
      captured.push({
        step,
        to: payload.to,
        from: payload.from,
        subject: payload.subject,
        html: payload.html,
        replyTo: payload.reply_to ?? payload.replyTo,
        headers: payload.headers ?? {},
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: `fake-${captured.length}` }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  // Must be set before email.ts is imported: it builds the Resend client and
  // reads env.inboundDomain at module scope.
  process.env.RESEND_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.RESEND_API_KEY = "re_e2e_fake_key";
  process.env.INBOUND_DOMAIN = INBOUND_DOMAIN;
  process.env.EMAIL_FROM = `waypoint@${INBOUND_DOMAIN}`;
  process.env.APP_URL = "http://localhost:3000";

  await cleanup();
  const { project, user } = await seed();
  // dispatchEmails() is global: it also mails any other open question in the
  // dev DB. Snapshot what it is about to mark as sent so we can undo it.
  const restore = await snapshotUnsent();
  const { dispatchEmails } = await import("../../apps/orchestrator/src/email");

  // ---- 1. plan approval: the first email for the task = thread root -------
  const thread = await task(project.id, user.id, EMAIL_FIXTURES.threadTaskId, EMAIL_TITLES.thread, {
    status: "AWAITING_PLAN_APPROVAL",
    currentStage: "PLANNING",
  });
  await question(thread, { kind: "PLAN_APPROVAL", text: PLAN_MARKDOWN });
  step = "plan";
  await dispatchEmails();

  // ---- 2. a follow-up question on the same task --------------------------
  await answerAll(EMAIL_FIXTURES.threadTaskId);
  await question(thread, {
    kind: "QUESTION",
    text: "Which cache backend?",
    contextSummary: "A follow-up question on an already-emailed task.",
  });
  step = "question";
  await dispatchEmails();

  // ---- 3. findings approval on the same task -----------------------------
  await answerAll(EMAIL_FIXTURES.threadTaskId);
  await question(thread, {
    kind: "FINDINGS_APPROVAL",
    text: "Review findings",
    contextSummary: "Findings needing approval.",
    items: [
      {
        number: 1,
        auto: false,
        severity: "high",
        category: "correctness",
        file: "apps/orchestrator/src/email.ts",
        description: "A gated finding.",
        suggestion: "Fix it.",
      },
      {
        number: null,
        auto: true,
        severity: "low",
        category: "readability",
        file: "apps/web/page.tsx",
        description: "An auto-fixed finding.",
      },
    ],
  });
  step = "findings";
  await dispatchEmails();

  // ---- 4. the DONE status email on the same task -------------------------
  await answerAll(EMAIL_FIXTURES.threadTaskId);
  await db.task.update({
    where: { id: EMAIL_FIXTURES.threadTaskId },
    data: { status: "DONE", prUrl: "https://github.com/example/e2e/pull/1" },
  });
  await statusChange(EMAIL_FIXTURES.threadTaskId, "DONE");
  step = "done";
  await dispatchEmails();

  // ---- 5. a task whose FIRST email is a status email ----------------------
  await task(project.id, user.id, EMAIL_FIXTURES.statusRootTaskId, EMAIL_TITLES.statusRoot, {
    status: "DONE",
  });
  await statusChange(EMAIL_FIXTURES.statusRootTaskId, "DONE");
  step = "status-root";
  await dispatchEmails();

  // ---- 6. pre-migration task: adopt the question's Message-ID as the root --
  const legacy = await task(project.id, user.id, EMAIL_FIXTURES.legacyTaskId, EMAIL_TITLES.legacy, {
    status: "DONE",
  });
  await question(legacy, {
    kind: "QUESTION",
    text: "Already emailed before the migration.",
    status: "ANSWERED",
    emailMessageId: LEGACY_ROOT_MESSAGE_ID,
  });
  await statusChange(EMAIL_FIXTURES.legacyTaskId, "DONE");
  step = "legacy";
  await dispatchEmails();

  // ---- 7. question + status email inside ONE dispatch tick ---------------
  const sameTick = await task(
    project.id,
    user.id,
    EMAIL_FIXTURES.sameTickTaskId,
    EMAIL_TITLES.sameTick,
    { status: "DONE" },
  );
  await question(sameTick, {
    kind: "QUESTION",
    text: "Answer me",
    contextSummary: "Open question emailed in the same tick as the done notice.",
  });
  await statusChange(EMAIL_FIXTURES.sameTickTaskId, "DONE");
  step = "same-tick";
  await dispatchEmails();

  // ---- 8. Resend rejects the root send -----------------------------------
  const failing = await task(
    project.id,
    user.id,
    EMAIL_FIXTURES.sendFailTaskId,
    EMAIL_TITLES.sendFail,
    { status: "DONE" },
  );
  await question(failing, {
    kind: "QUESTION",
    text: "This send fails",
    contextSummary: "Resend rejects this one.",
  });
  step = "send-fail";
  await dispatchEmails();

  // ---- 9. plan.md carrying raw HTML --------------------------------------
  const planHtml = await task(
    project.id,
    user.id,
    EMAIL_FIXTURES.planHtmlTaskId,
    EMAIL_TITLES.planHtml,
    { status: "AWAITING_PLAN_APPROVAL", currentStage: "PLANNING" },
  );
  await question(planHtml, { kind: "PLAN_APPROVAL", text: PLAN_WITH_RAW_HTML });
  step = "plan-html";
  await dispatchEmails();

  // ---- report ------------------------------------------------------------
  const tasks = await db.task.findMany({
    where: { id: { in: TASK_IDS } },
    select: { id: true, emailMessageId: true },
  });
  const questions = await db.question.findMany({
    where: { taskId: { in: TASK_IDS } },
    select: { id: true, taskId: true, kind: true, emailMessageId: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  const report: Report = {
    emails: captured,
    tasks: Object.fromEntries(tasks.map((t) => [t.id, t.emailMessageId])),
    questions: Object.fromEntries(
      questions.map((q, i) => [`${q.taskId}#${i}-${q.kind}`, q.emailMessageId]),
    ),
  };

  await cleanup();
  await restore();
  server.close();
  console.log(REPORT_BEGIN);
  console.log(JSON.stringify(report));
  console.log(REPORT_END);
}

// ---------------------------------------------------------------------------

async function seed() {
  const user = await db.user.upsert({
    where: { email: "dev@waypoint.local" },
    update: {},
    create: { email: "dev@waypoint.local", name: "Dev Bypass" },
  });
  const project = await db.project.upsert({
    where: { name: EMAIL_FIXTURES.projectName },
    update: {},
    create: {
      name: EMAIL_FIXTURES.projectName,
      repoUrl: "https://github.com/example/e2e-fixtures.git",
      setupCommand: "bun install",
      runCommand: "bun run dev",
      testCommand: "bun test",
    },
  });
  // recipients() drops @waypoint.local, so the fixtures need a real-looking one
  await db.allowedEmail.upsert({
    where: { email: EMAIL_RECIPIENT },
    update: {},
    create: { email: EMAIL_RECIPIENT },
  });
  return { user, project };
}

/**
 * Leave the dev DB as we found it: rows outside the fixtures that this run
 * marked as emailed go back to un-emailed, and the `email-sent:{eventId}`
 * markers it wrote are removed. Without this, a real Resend key would later
 * skip notifications the user never actually received.
 */
async function snapshotUnsent(): Promise<() => Promise<void>> {
  const startedAt = new Date();
  const questionIds = (
    await db.question.findMany({
      where: { emailMessageId: null, taskId: { notIn: TASK_IDS } },
      select: { id: true },
    })
  ).map((q) => q.id);
  const taskIds = (
    await db.task.findMany({
      where: { emailMessageId: null, id: { notIn: TASK_IDS } },
      select: { id: true },
    })
  ).map((t) => t.id);

  return async () => {
    await db.question.updateMany({
      where: { id: { in: questionIds } },
      data: { emailMessageId: null },
    });
    await db.task.updateMany({ where: { id: { in: taskIds } }, data: { emailMessageId: null } });
    const markers = await db.event.findMany({
      where: { type: "LOG", createdAt: { gte: startedAt } },
      select: { id: true, payload: true },
    });
    const ids = markers
      .filter((m) => ((m.payload as { line?: string }).line ?? "").startsWith("email-sent:"))
      .map((m) => m.id);
    await db.event.deleteMany({ where: { id: { in: ids } } });
  };
}

async function cleanup(): Promise<void> {
  await db.task.deleteMany({ where: { id: { in: TASK_IDS } } });
  await db.allowedEmail.deleteMany({ where: { email: EMAIL_RECIPIENT } });
}

async function task(
  projectId: string,
  createdById: string,
  id: string,
  title: string,
  extra: Record<string, unknown> = {},
) {
  return db.task.create({
    data: {
      id,
      projectId,
      createdById,
      title,
      prompt: "Email dispatch fixture.",
      difficulty: "EASY",
      ...MODELS,
      ...extra,
      stageRuns: {
        create: {
          stage: "PLANNING",
          attempt: 1,
          model: MODELS.planningModel,
          status: "SUCCEEDED",
        },
      },
    },
    include: { stageRuns: true },
  });
}

async function question(
  t: { id: string; stageRuns: { id: string }[] },
  data: Record<string, unknown>,
) {
  return db.question.create({
    data: {
      taskId: t.id,
      stageRunId: t.stageRuns[0].id,
      contextSummary: "Email dispatch fixture question.",
      status: "OPEN",
      ...data,
    } as never,
  });
}

/** Close a task's open questions so the next dispatch only sends the new one. */
async function answerAll(taskId: string): Promise<void> {
  await db.question.updateMany({
    where: { taskId, status: "OPEN" },
    data: { status: "ANSWERED", answer: "ok", answeredVia: "UI" },
  });
}

async function statusChange(taskId: string, to: string): Promise<void> {
  await db.event.create({
    data: { taskId, type: "STATUS_CHANGE", payload: { from: "IMPLEMENTING", to } },
  });
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
