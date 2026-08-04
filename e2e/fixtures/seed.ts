/**
 * Deterministic fixtures for the e2e suite.
 *
 * Creates one project and a task pinned to each UI state the specs need:
 *   e2e-steer      IMPLEMENTING            -> Steer form under the stage-run list
 *   e2e-question   NEEDS_INPUT + question  -> answer form inside its stage row
 *   e2e-plan       AWAITING_PLAN_APPROVAL  -> Approve / Request changes in the Planning row
 *   e2e-options    NEEDS_INPUT + options   -> segmented answer options in its stage row
 *   e2e-prompt     IMPLEMENTING            -> long markdown-ish prompt for the Prompt panel
 *   e2e-blank      PAUSED                  -> whitespace-only prompt, Prompt panel empty state
 *   e2e-failed     FAILED                  -> Retry dialog beside the Prompt panel
 *   e2e-history    DONE                    -> full Planning→Impl→Review history + PR row
 *   e2e-skip       TESTING + skipTesting   -> the Testing skip branch's sync replay
 *   e2e-skip-red   TESTING + skipTesting   -> same, for the red-suite bounce
 *
 * Idempotent: re-running deletes and recreates the fixture tasks. Task ids are
 * fixed so specs can navigate straight to /tasks/{id} without discovery.
 *
 * Run with the repo env loaded, e.g.
 *   set -a; source .env.local; set +a
 *   DATABASE_URL=file:$PWD/packages/core/prisma/dev.db \
 *   TASK_DATA_DIR=$PWD/.local/tasks bunx tsx e2e/fixtures/seed.ts
 */
import { promises as fs } from "node:fs";
import { artifactDir, artifactPath } from "@waypoint/core";
import { db } from "@waypoint/core/db";
import {
  CREATED_TASK_PREFIX,
  FIXTURES,
  HISTORY_RUNS,
  PROMPT_FIXTURE_TEXT,
  SKIP_TESTING_TOKENS,
} from "./ids";

const MODELS = {
  planningModel: "claude-fable-5",
  implementationModel: "claude-fable-5",
  reviewModel: "claude-fable-5",
  testingModel: "claude-fable-5",
};

/** Minutes past a fixed epoch — deterministic timestamps for the history task. */
const t = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes));

async function main() {
  const user = await db.user.upsert({
    where: { email: "dev@waypoint.local" },
    update: {},
    create: { email: "dev@waypoint.local", name: "Dev Bypass" },
  });

  const project = await db.project.upsert({
    where: { name: FIXTURES.projectName },
    update: {},
    create: {
      name: FIXTURES.projectName,
      repoUrl: "https://github.com/example/e2e-fixtures.git",
      setupCommand: "bun install",
      runCommand: "bun run dev",
      testCommand: "bun test",
    },
  });

  const ids = [
    FIXTURES.steerTaskId,
    FIXTURES.questionTaskId,
    FIXTURES.planTaskId,
    FIXTURES.optionsTaskId,
    FIXTURES.promptTaskId,
    FIXTURES.blankPromptTaskId,
    FIXTURES.failedTaskId,
    FIXTURES.historyTaskId,
    FIXTURES.skipTestingTaskId,
    FIXTURES.skipTestingRedTaskId,
  ];
  await db.task.deleteMany({ where: { id: { in: ids } } });
  // tasks the specs create through the New Task form — they have real ids, so
  // they are matched by title instead
  await db.task.deleteMany({ where: { title: { startsWith: CREATED_TASK_PREFIX } } });

  // 1. running task -> Steer form on the Activity tab
  await db.task.create({
    data: {
      id: FIXTURES.steerTaskId,
      projectId: project.id,
      createdById: user.id,
      title: "E2E — steer form",
      prompt: "Fixture task parked in IMPLEMENTING so the steer box renders.",
      difficulty: "EASY",
      status: "IMPLEMENTING",
      currentStage: "IMPLEMENTATION",
      ...MODELS,
      stageRuns: {
        create: {
          stage: "IMPLEMENTATION",
          attempt: 1,
          model: MODELS.implementationModel,
          status: "RUNNING",
        },
      },
    },
  });

  // 2. open free-text question -> Send form on the Questions tab
  const questionTask = await db.task.create({
    data: {
      id: FIXTURES.questionTaskId,
      projectId: project.id,
      createdById: user.id,
      title: "E2E — question answer form",
      prompt: "Fixture task parked in NEEDS_INPUT with one open question.",
      difficulty: "EASY",
      status: "NEEDS_INPUT",
      currentStage: "IMPLEMENTATION",
      ...MODELS,
      stageRuns: {
        create: {
          stage: "IMPLEMENTATION",
          attempt: 1,
          model: MODELS.implementationModel,
          status: "RUNNING",
        },
      },
    },
    include: { stageRuns: true },
  });
  await db.question.create({
    data: {
      taskId: questionTask.id,
      stageRunId: questionTask.stageRuns[0].id,
      kind: "QUESTION",
      text: "Which cache backend should the session store use?",
      contextSummary: "Fixture question for the e2e answer form.",
      status: "OPEN",
    },
  });

  // 3. pending plan approval -> Approve plan / Request changes on the Plan tab
  const planTask = await db.task.create({
    data: {
      id: FIXTURES.planTaskId,
      projectId: project.id,
      createdById: user.id,
      title: "E2E — plan approval",
      prompt: "Fixture task parked in AWAITING_PLAN_APPROVAL.",
      difficulty: "MEDIUM",
      status: "AWAITING_PLAN_APPROVAL",
      currentStage: "PLANNING",
      ...MODELS,
      stageRuns: {
        create: {
          stage: "PLANNING",
          attempt: 1,
          model: MODELS.planningModel,
          status: "SUCCEEDED",
          endedAt: new Date(),
        },
      },
    },
    include: { stageRuns: true },
  });
  await db.question.create({
    data: {
      taskId: planTask.id,
      stageRunId: planTask.stageRuns[0].id,
      kind: "PLAN_APPROVAL",
      text: "Plan ready for approval.",
      contextSummary: "Fixture plan approval for the e2e suite.",
      status: "OPEN",
    },
  });
  await fs.mkdir(artifactDir(planTask.id), { recursive: true });
  await fs.writeFile(
    artifactPath(planTask.id, "plan.md"),
    "# Fixture plan\n\n- [ ] Step one\n- [ ] Step two\n",
    "utf8",
  );

  // 4. open question WITH options -> segmented ButtonGroup above the Send form
  const optionsTask = await db.task.create({
    data: {
      id: FIXTURES.optionsTaskId,
      projectId: project.id,
      createdById: user.id,
      title: "E2E — question with options",
      prompt: "Fixture task parked in NEEDS_INPUT with a multiple-choice question.",
      difficulty: "EASY",
      status: "NEEDS_INPUT",
      currentStage: "IMPLEMENTATION",
      ...MODELS,
      stageRuns: {
        create: {
          stage: "IMPLEMENTATION",
          attempt: 1,
          model: MODELS.implementationModel,
          status: "RUNNING",
        },
      },
    },
    include: { stageRuns: true },
  });
  await db.question.create({
    data: {
      taskId: optionsTask.id,
      stageRunId: optionsTask.stageRuns[0].id,
      kind: "QUESTION",
      text: "Should the migration run automatically on boot?",
      contextSummary: "Fixture multiple-choice question for the e2e suite.",
      options: ["Yes", "No"],
      status: "OPEN",
    },
  });

  // 5. multi-line markdown-ish prompt -> read-only Prompt panel rendering
  await db.task.create({
    data: {
      id: FIXTURES.promptTaskId,
      projectId: project.id,
      createdById: user.id,
      title: "E2E — prompt panel rendering",
      prompt: PROMPT_FIXTURE_TEXT,
      difficulty: "EASY",
      status: "IMPLEMENTING",
      currentStage: "IMPLEMENTATION",
      ...MODELS,
      stageRuns: {
        create: {
          stage: "IMPLEMENTATION",
          attempt: 1,
          model: MODELS.implementationModel,
          status: "RUNNING",
        },
      },
    },
  });

  // 6. whitespace-only prompt -> the Prompt panel's empty branch
  await db.task.create({
    data: {
      id: FIXTURES.blankPromptTaskId,
      projectId: project.id,
      createdById: user.id,
      title: "E2E — blank prompt",
      prompt: "   \n  ",
      difficulty: "EASY",
      // PAUSED, not QUEUED: a queued fixture would be picked up by the orchestrator
      status: "PAUSED",
      currentStage: "PLANNING",
      ...MODELS,
    },
  });

  // 7. FAILED -> the Retry dialog (the other, editable, use of Task.prompt)
  await db.task.create({
    data: {
      id: FIXTURES.failedTaskId,
      projectId: project.id,
      createdById: user.id,
      title: "E2E — failed task",
      prompt: "Fixture task parked in FAILED so the Retry dialog renders.",
      difficulty: "EASY",
      status: "FAILED",
      failureCode: "GIT_CLONE",
      currentStage: "PLANNING",
      ...MODELS,
    },
  });

  // 8. finished task with a full run history -> stage-run list, findings, PR row
  const historyTask = await db.task.create({
    data: {
      id: FIXTURES.historyTaskId,
      projectId: project.id,
      createdById: user.id,
      title: "E2E — stage-run history",
      prompt: "Fixture task finished through review with a PR.",
      difficulty: "MEDIUM",
      status: "DONE",
      currentStage: "REVIEW",
      reviewCycles: 1,
      branchName: "waypoint/e2e-history",
      prUrl: "https://github.com/example/e2e-fixtures/pull/7",
      checklist: [
        { text: "Wire the settings form", state: "completed" },
        { text: "Add e2e coverage", state: "completed" },
      ],
      ...MODELS,
      stageRuns: {
        create: [
          {
            id: HISTORY_RUNS.planning,
            stage: "PLANNING",
            attempt: 1,
            model: MODELS.planningModel,
            status: "SUCCEEDED",
            inputTokens: 12_000,
            outputTokens: 6_000,
            cacheReadTokens: 30_000,
            cacheCreationTokens: 2_000,
            startedAt: t(0),
            endedAt: t(10),
          },
          {
            id: HISTORY_RUNS.implementation,
            stage: "IMPLEMENTATION",
            attempt: 1,
            model: MODELS.implementationModel,
            status: "SUCCEEDED",
            inputTokens: 40_000,
            outputTokens: 25_000,
            cacheReadTokens: 90_000,
            cacheCreationTokens: 8_000,
            startedAt: t(10),
            endedAt: t(20),
          },
          {
            id: HISTORY_RUNS.review,
            stage: "REVIEW",
            attempt: 1,
            model: MODELS.reviewModel,
            status: "SUCCEEDED",
            inputTokens: 15_000,
            outputTokens: 5_000,
            cacheReadTokens: 40_000,
            cacheCreationTokens: 3_000,
            startedAt: t(20),
            endedAt: t(25),
          },
        ],
      },
    },
  });
  await db.event.createMany({
    data: [
      {
        taskId: historyTask.id,
        stageRunId: HISTORY_RUNS.planning,
        type: "STAGE_START",
        payload: { stage: "PLANNING", attempt: 1, model: MODELS.planningModel },
        createdAt: t(0),
      },
      {
        // deliberately NULL stageRunId — must resolve into the implementation
        // row via its [start, next start) window
        taskId: historyTask.id,
        type: "STATUS_CHANGE",
        payload: { from: "PLANNING", to: "IMPLEMENTING" },
        createdAt: t(10),
      },
      {
        taskId: historyTask.id,
        stageRunId: HISTORY_RUNS.implementation,
        type: "LOG",
        payload: { source: "assistant", line: "Refactoring the settings form" },
        createdAt: t(12),
      },
      {
        taskId: historyTask.id,
        type: "PR_OPENED",
        payload: { url: "https://github.com/example/e2e-fixtures/pull/7" },
        createdAt: t(26),
      },
    ],
  });
  await db.question.create({
    data: {
      taskId: historyTask.id,
      stageRunId: HISTORY_RUNS.implementation,
      kind: "QUESTION",
      text: "Keep the legacy settings export?",
      contextSummary: "Fixture answered question for the history task.",
      status: "ANSWERED",
      answer: "Drop it.",
      answeredVia: "UI",
      createdAt: t(14),
      answeredAt: t(15),
    },
  });
  await fs.mkdir(artifactDir(historyTask.id), { recursive: true });
  await fs.writeFile(
    artifactPath(historyTask.id, "plan.md"),
    "# History plan\n\n- [x] Step one\n- [x] Step two\n",
    "utf8",
  );
  await fs.writeFile(
    artifactPath(historyTask.id, "review-findings-1.json"),
    JSON.stringify({
      verdict: "approve",
      findings: [
        {
          severity: "low",
          category: "readability",
          file: "apps/web/example.ts",
          description: "Fixture finding for the e2e suite.",
          suggestion: "Rename the helper.",
        },
      ],
    }),
    "utf8",
  );

  // 9 + 10. "Skip browser testing" tasks parked at the start of the Testing
  // stage. The runner's skip branch never boots the app or the browser agent —
  // it runs the test gate, pushes, and reports the stage over the sync
  // endpoint — so the specs replay those payloads against these two rows: one
  // for the green suite (→ Opening PR) and one for a red one (→ Implementing).
  for (const [id, title] of [
    [FIXTURES.skipTestingTaskId, "E2E — skip browser testing"],
    [FIXTURES.skipTestingRedTaskId, "E2E — skip browser testing, red suite"],
  ] as const) {
    await db.task.create({
      data: {
        id,
        projectId: project.id,
        createdById: user.id,
        title,
        prompt: "Backend-only change with no UI; browser testing is skipped.",
        difficulty: "EASY",
        status: "TESTING",
        currentStage: "TESTING",
        skipTesting: true,
        branchName: "waypoint/e2e-skip",
        runnerToken: SKIP_TESTING_TOKENS[id],
        ...MODELS,
      },
    });
  }

  console.log("[e2e seed] fixtures ready");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
