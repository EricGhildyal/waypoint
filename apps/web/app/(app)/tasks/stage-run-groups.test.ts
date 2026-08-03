import { describe, expect, test } from "bun:test";
import type { QuestionView, StageRunView, TaskDetail } from "@/lib/task-detail";
import {
  type FeedEvent,
  type Section,
  buildSections,
  resolveQuestionSection,
} from "./stage-run-groups";

/** Minutes past a fixed epoch, as the toISOString shape the API serves. */
function iso(minutes: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, minutes)).toISOString();
}

let seq = 0;

function run(
  over: Partial<StageRunView> & Pick<StageRunView, "id" | "stage" | "startedAt">,
): StageRunView {
  return {
    attempt: 1,
    model: "model-x",
    status: "SUCCEEDED",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    endedAt: null,
    ...over,
  };
}

function ev(over: Partial<FeedEvent> & Pick<FeedEvent, "type" | "createdAt">): FeedEvent {
  return { id: `e-${++seq}`, stageRunId: null, payload: {}, ...over };
}

function question(
  over: Partial<QuestionView> & Pick<QuestionView, "id" | "stageRunId" | "createdAt">,
): QuestionView {
  return {
    kind: "QUESTION",
    text: "q?",
    contextSummary: "",
    options: null,
    items: null,
    status: "OPEN",
    answer: null,
    answeredVia: null,
    answeredAt: null,
    ...over,
  };
}

function makeTask(over: Partial<TaskDetail>): TaskDetail {
  return {
    id: "task-1",
    title: "t",
    prompt: "p",
    difficulty: "MEDIUM",
    status: "IMPLEMENTING",
    currentStage: null,
    pauseReason: null,
    failureCode: null,
    failureDetail: null,
    checklist: null,
    models: { planning: "m", implementation: "m", review: "m", testing: "m" },
    project: { id: "p1", name: "proj", repoUrl: "", defaultBranch: "main" },
    scheduledAt: null,
    dependsOnTaskId: null,
    tokenBudget: null,
    tokenTotal: 0,
    branchName: null,
    prUrl: null,
    reviewCycles: 0,
    testingCycles: 0,
    createdAt: iso(0),
    startedAt: null,
    endedAt: null,
    stageRuns: [],
    questions: [],
    plan: null,
    prBody: null,
    findings: [],
    ...over,
  };
}

/** The bounce-back pipeline used by most tests. */
const BOUNCE_RUNS = [
  run({ id: "plan-1", stage: "PLANNING", startedAt: iso(0), endedAt: iso(10) }),
  run({ id: "impl-1", stage: "IMPLEMENTATION", startedAt: iso(10), endedAt: iso(20) }),
  run({ id: "rev-1", stage: "REVIEW", startedAt: iso(20), endedAt: iso(25) }),
  run({ id: "impl-2", stage: "IMPLEMENTATION", attempt: 2, startedAt: iso(25), endedAt: iso(35) }),
];

function sectionKeys(sections: Section[]): string[] {
  return sections.map((s) =>
    s.kind === "run" ? s.run.id : s.kind === "placeholder" ? `placeholder-${s.stage}` : s.kind,
  );
}

describe("buildSections", () => {
  test("orders bounce-back runs chronologically and appends placeholders", () => {
    const task = makeTask({ status: "IMPLEMENTING", stageRuns: BOUNCE_RUNS });
    expect(sectionKeys(buildSections(task, []))).toEqual([
      "plan-1",
      "impl-1",
      "rev-1",
      "impl-2",
      "placeholder-TESTING",
      "placeholder-PR",
    ]);
  });

  test("an event with a real stageRunId lands in that run regardless of timestamp", () => {
    const task = makeTask({ stageRuns: BOUNCE_RUNS });
    const late = ev({ type: "LOG", createdAt: iso(30), stageRunId: "plan-1" });
    const sections = buildSections(task, [late]);
    const planning = sections.find((s) => s.kind === "run" && s.run.id === "plan-1");
    expect(planning?.kind === "run" && planning.items).toEqual([
      { kind: "event", event: late, at: late.createdAt },
    ]);
  });

  test("a NULL-stageRunId event resolves to the run whose window covers it", () => {
    const task = makeTask({ stageRuns: BOUNCE_RUNS });
    const statusChange = ev({ type: "STATUS_CHANGE", createdAt: iso(22) });
    const sections = buildSections(task, [statusChange]);
    const review = sections.find((s) => s.kind === "run" && s.run.id === "rev-1");
    expect(review?.kind === "run" && review.items[0]).toEqual({
      kind: "event",
      event: statusChange,
      at: statusChange.createdAt,
    });
  });

  test("a dangling stageRunId falls back to timestamp resolution", () => {
    const task = makeTask({ stageRuns: BOUNCE_RUNS });
    const dangling = ev({ type: "LOG", createdAt: iso(12), stageRunId: "gone" });
    const sections = buildSections(task, [dangling]);
    const impl = sections.find((s) => s.kind === "run" && s.run.id === "impl-1");
    expect(impl?.kind === "run" && impl.items).toHaveLength(1);
  });

  test("pre-first-run events go to a Setup section listed first", () => {
    const task = makeTask({
      stageRuns: [run({ id: "plan-1", stage: "PLANNING", startedAt: iso(5) })],
    });
    const early = ev({ type: "STATUS_CHANGE", createdAt: iso(1) });
    const sections = buildSections(task, [early]);
    expect(sections[0]).toEqual({
      kind: "setup",
      items: [{ kind: "event", event: early, at: early.createdAt }],
    });
  });

  test("a brand-new task shows all five placeholders and no Setup without events", () => {
    const task = makeTask({ status: "QUEUED" });
    expect(sectionKeys(buildSections(task, []))).toEqual([
      "placeholder-PLANNING",
      "placeholder-IMPLEMENTATION",
      "placeholder-REVIEW",
      "placeholder-TESTING",
      "placeholder-PR",
    ]);
  });

  test("a sentinel-stageRunId question resolves by timestamp", () => {
    const q = question({ id: "q1", stageRunId: "orchestrator", createdAt: iso(12) });
    const task = makeTask({ stageRuns: BOUNCE_RUNS, questions: [q] });
    const sections = buildSections(task, []);
    const impl = sections.find((s) => s.kind === "run" && s.run.id === "impl-1");
    expect(impl?.kind === "run" && impl.items).toEqual([
      { kind: "question", question: q, at: q.createdAt },
    ]);
  });

  test("post-last-run events go to PR when reached, else stay on the last run", () => {
    const straggler = ev({ type: "LOG", createdAt: iso(40) });
    const reached = buildSections(
      makeTask({ status: "OPENING_PR", stageRuns: BOUNCE_RUNS }),
      [straggler],
    );
    const pr = reached.find((s) => s.kind === "pr");
    expect(pr?.kind === "pr" && pr.items).toHaveLength(1);

    const notReached = buildSections(
      makeTask({ status: "FAILED", stageRuns: BOUNCE_RUNS }),
      [straggler],
    );
    expect(notReached.find((s) => s.kind === "pr")).toBeUndefined();
    const last = notReached.find((s) => s.kind === "run" && s.run.id === "impl-2");
    expect(last?.kind === "run" && last.items).toHaveLength(1);
  });

  test("PR_OPENED always lands in the PR section and forces its existence", () => {
    const opened = ev({ type: "PR_OPENED", createdAt: iso(3) });
    const sections = buildSections(makeTask({ stageRuns: BOUNCE_RUNS }), [opened]);
    const pr = sections.find((s) => s.kind === "pr");
    expect(pr?.kind === "pr" && pr.items).toEqual([
      { kind: "event", event: opened, at: opened.createdAt },
    ]);
  });

  test("findings artifacts join their run by stage and attempt", () => {
    const reviewFindings = {
      kind: "review" as const,
      attempt: 1,
      findings: { verdict: "request_changes" as const, findings: [] },
    };
    const task = makeTask({ stageRuns: BOUNCE_RUNS, findings: [reviewFindings] });
    const sections = buildSections(task, []);
    const review = sections.find((s) => s.kind === "run" && s.run.id === "rev-1");
    expect(review?.kind === "run" && review.findings).toEqual([reviewFindings]);
    const impl = sections.find((s) => s.kind === "run" && s.run.id === "impl-1");
    expect(impl?.kind === "run" && impl.findings).toEqual([]);
  });

  test("terminal tasks get no placeholders", () => {
    for (const status of ["DONE", "FAILED", "CANCELLED"]) {
      const sections = buildSections(makeTask({ status, stageRuns: BOUNCE_RUNS }), []);
      expect(sections.some((s) => s.kind === "placeholder")).toBe(false);
    }
  });

  test("items sort by time with question cards after event lines at equal timestamps", () => {
    const q = question({ id: "q1", stageRunId: "impl-1", createdAt: iso(15) });
    const raised = ev({ type: "QUESTION", createdAt: iso(15), stageRunId: "impl-1" });
    const later = ev({ type: "LOG", createdAt: iso(16), stageRunId: "impl-1" });
    const task = makeTask({ stageRuns: BOUNCE_RUNS, questions: [q] });
    const sections = buildSections(task, [later, raised]);
    const impl = sections.find((s) => s.kind === "run" && s.run.id === "impl-1");
    expect(impl?.kind === "run" && impl.items.map((i) => i.kind)).toEqual([
      "event",
      "question",
      "event",
    ]);
  });
});

describe("resolveQuestionSection", () => {
  const task = makeTask({
    stageRuns: BOUNCE_RUNS,
    questions: [
      question({ id: "q-real", stageRunId: "rev-1", createdAt: iso(21) }),
      question({ id: "q-sentinel", stageRunId: "runner", createdAt: iso(12) }),
    ],
  });

  test("real stageRunId resolves directly", () => {
    expect(resolveQuestionSection(task, "q-real")).toBe("rev-1");
  });

  test("sentinel stageRunId resolves by timestamp", () => {
    expect(resolveQuestionSection(task, "q-sentinel")).toBe("impl-1");
  });

  test("unknown question id resolves to null", () => {
    expect(resolveQuestionSection(task, "nope")).toBeNull();
  });
});
