/**
 * Deterministic fixtures for the e2e suite.
 *
 * Creates one project and a task pinned to each UI state the specs need:
 *   e2e-steer      IMPLEMENTING            -> Activity tab renders the Steer form
 *   e2e-question   NEEDS_INPUT + question  -> Questions tab renders the answer form
 *   e2e-plan       AWAITING_PLAN_APPROVAL  -> Plan tab renders Approve / Request changes
 *   e2e-options    NEEDS_INPUT + options   -> segmented options above the Send form
 *   e2e-prompt     IMPLEMENTING            -> long markdown-ish prompt for the Prompt panel
 *   e2e-blank      PAUSED                  -> whitespace-only prompt, Prompt panel empty state
 *   e2e-failed     FAILED                  -> Retry dialog beside the Prompt panel
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
import { FIXTURES, PROMPT_FIXTURE_TEXT } from "./ids";

const MODELS = {
  planningModel: "claude-fable-5",
  implementationModel: "claude-fable-5",
  reviewModel: "claude-fable-5",
  testingModel: "claude-fable-5",
};

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
  ];
  await db.task.deleteMany({ where: { id: { in: ids } } });

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

  console.log("[e2e seed] fixtures ready");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
