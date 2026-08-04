import type { FindingsView, QuestionView, StageRunView, TaskDetail } from "@/lib/task-detail";

/** One event row from GET /api/tasks/{id}/events. */
export interface FeedEvent {
  id: string;
  type: string;
  stageRunId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export const PIPELINE_STAGES = ["PLANNING", "IMPLEMENTATION", "REVIEW", "TESTING", "PR"] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

// Question.stageRunId sentinels written by the runner sync route ("runner") and
// the orchestrator (ORCHESTRATOR_STAGE_RUN_ID) — copied here rather than
// imported from @waypoint/core, which would pull Prisma into the client bundle.
const SENTINEL_RUN_IDS = new Set(["runner", "orchestrator"]);

export type RowItem =
  | { kind: "event"; event: FeedEvent; at: string }
  | { kind: "question"; question: QuestionView; at: string };

export type Section =
  | { kind: "setup"; items: RowItem[] }
  | { kind: "run"; run: StageRunView; items: RowItem[]; findings: FindingsView[] }
  | { kind: "pr"; items: RowItem[] }
  | { kind: "placeholder"; stage: PipelineStage };

const TERMINAL_STATUSES = new Set(["DONE", "FAILED", "CANCELLED"]);

/**
 * Groups a task's events, questions, and findings into the ordered sections the
 * stage-run list renders: Setup (pre-first-run stragglers) → one section per
 * StageRun in start order → PR → grayed placeholders for pipeline stages that
 * haven't started. Events with a NULL/dangling/sentinel stageRunId are assigned
 * to the run whose time window covers them. Pure and deterministic — all
 * timestamps are toISOString UTC strings, so plain string comparison orders
 * them.
 */
export function buildSections(task: TaskDetail, events: FeedEvent[]): Section[] {
  const runs = sortRuns(task.stageRuns);
  const runIds = new Set(runs.map((r) => r.id));
  const prReached =
    task.status === "OPENING_PR" ||
    task.status === "DONE" ||
    Boolean(task.prUrl) ||
    events.some((e) => e.type === "PR_OPENED");

  const buckets = new Map<string, RowItem[]>();
  const push = (key: string, item: RowItem) => {
    const list = buckets.get(key);
    if (list) list.push(item);
    else buckets.set(key, [item]);
  };

  for (const event of events) {
    const key =
      event.type === "PR_OPENED"
        ? "pr"
        : event.stageRunId && runIds.has(event.stageRunId)
          ? event.stageRunId
          : resolveByTime(runs, prReached, event.createdAt);
    push(key, { kind: "event", event, at: event.createdAt });
  }

  for (const question of task.questions) {
    const key =
      !SENTINEL_RUN_IDS.has(question.stageRunId) && runIds.has(question.stageRunId)
        ? question.stageRunId
        : resolveByTime(runs, prReached, question.createdAt);
    push(key, { kind: "question", question, at: question.createdAt });
  }

  const sections: Section[] = [];
  const setupItems = sortItems(buckets.get("setup") ?? []);
  if (setupItems.length) sections.push({ kind: "setup", items: setupItems });
  for (const run of runs) {
    sections.push({
      kind: "run",
      run,
      items: sortItems(buckets.get(run.id) ?? []),
      findings: task.findings.filter(
        (f) =>
          (f.kind === "review" ? "REVIEW" : "TESTING") === run.stage && f.attempt === run.attempt,
      ),
    });
  }
  if (prReached) sections.push({ kind: "pr", items: sortItems(buckets.get("pr") ?? []) });

  if (!TERMINAL_STATUSES.has(task.status)) {
    const reachedIndex = Math.max(
      prReached ? PIPELINE_STAGES.length - 1 : -1,
      ...runs.map((r) => PIPELINE_STAGES.indexOf(r.stage as PipelineStage)),
    );
    for (const stage of PIPELINE_STAGES.slice(reachedIndex + 1)) {
      sections.push({ kind: "placeholder", stage });
    }
  }

  return sections;
}

/**
 * The section key (`run.id`, "setup", or "pr") a ?focus=question-{id} deeplink
 * should expand. Null when the question doesn't exist (e.g. the legacy
 * ?focus=questions link).
 */
export function resolveQuestionSection(task: TaskDetail, questionId: string): string | null {
  const question = task.questions.find((q) => q.id === questionId);
  if (!question) return null;
  const runs = sortRuns(task.stageRuns);
  if (!SENTINEL_RUN_IDS.has(question.stageRunId) && runs.some((r) => r.id === question.stageRunId))
    return question.stageRunId;
  // No event list at seeding time — PR-phase reachability from the task alone.
  const prReached = task.status === "OPENING_PR" || task.status === "DONE" || Boolean(task.prUrl);
  return resolveByTime(runs, prReached, question.createdAt);
}

function sortRuns(runs: StageRunView[]): StageRunView[] {
  return runs.toSorted((a, b) => {
    if (a.startedAt !== b.startedAt) return a.startedAt < b.startedAt ? -1 : 1;
    const byStage =
      PIPELINE_STAGES.indexOf(a.stage as PipelineStage) -
      PIPELINE_STAGES.indexOf(b.stage as PipelineStage);
    return byStage || a.attempt - b.attempt;
  });
}

/**
 * The run whose half-open window [start, next start) covers `at`. Events after
 * the last run's end go to the PR section when the task got that far; a failed
 * task's post-mortem events stay on the run that failed.
 */
function resolveByTime(runs: StageRunView[], prReached: boolean, at: string): string {
  const first = runs[0];
  const last = runs[runs.length - 1];
  if (!first || !last || at < first.startedAt) return "setup";
  for (let i = 0; i < runs.length - 1; i++) {
    const current = runs[i];
    const next = runs[i + 1];
    if (current && next && at < next.startedAt) return current.id;
  }
  if (last.endedAt === null || at <= last.endedAt) return last.id;
  return prReached ? "pr" : last.id;
}

// Question cards sort after event lines at equal timestamps so the QUESTION
// highlight line introduces its card.
const itemRank = (item: RowItem) => (item.kind === "question" ? 1 : 0);

function sortItems(items: RowItem[]): RowItem[] {
  return items.toSorted((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : itemRank(a) - itemRank(b)));
}
