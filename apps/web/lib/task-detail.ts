import { promises as fs } from "node:fs";
import {
  FindingsSchema,
  artifactDir,
  artifactPath,
  db,
  parseFindingSelection,
} from "@waypoint/core";
import type { ChecklistItem, FindingApprovalItem, Findings } from "@waypoint/core";
import { ApiError } from "./api";

export interface StageRunView {
  id: string;
  stage: string;
  attempt: number;
  model: string;
  status: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  startedAt: string;
  endedAt: string | null;
}

export interface QuestionView {
  id: string;
  /** May be a real StageRun id or the sentinel strings "runner"/"orchestrator". */
  stageRunId: string;
  kind: string;
  text: string;
  contextSummary: string;
  options: string[] | null;
  /** FINDINGS_APPROVAL only — the checkbox list. */
  items: FindingApprovalItem[] | null;
  /**
   * FINDINGS_APPROVAL only — the gated finding numbers an answered gate
   * approved, decoded here rather than in the browser so the client keeps no
   * second copy of parseFindingSelection. Null while the gate is still open.
   */
  approvedNumbers: number[] | null;
  status: string;
  answer: string | null;
  answeredVia: string | null;
  createdAt: string;
  answeredAt: string | null;
}

export interface FindingsView {
  kind: "review" | "test";
  attempt: number;
  findings: Findings;
}

export interface TaskDetail {
  id: string;
  title: string;
  prompt: string;
  difficulty: string;
  status: string;
  currentStage: string | null;
  pauseReason: string | null;
  failureCode: string | null;
  failureDetail: string | null;
  checklist: ChecklistItem[] | null;
  models: { planning: string; implementation: string; review: string; testing: string };
  skipTesting: boolean;
  project: { id: string; name: string; repoUrl: string; defaultBranch: string };
  scheduledAt: string | null;
  /** The task this one waits on (BLOCKED), kept as history once the gate clears. */
  dependsOn: { id: string; title: string; status: string } | null;
  /** Tasks waiting on this one; the stop dialog resolves the BLOCKED ones. */
  dependents: Array<{ id: string; title: string; status: string }>;
  tokenBudget: number | null;
  tokenTotal: number;
  branchName: string | null;
  prUrl: string | null;
  reviewCycles: number;
  testingCycles: number;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  stageRuns: StageRunView[];
  questions: QuestionView[];
  plan: string | null;
  prBody: string | null;
  findings: FindingsView[];
}

export async function getTaskDetail(taskId: string): Promise<TaskDetail> {
  const task = await db.task.findUnique({
    where: { id: taskId },
    include: {
      project: true,
      dependsOn: { select: { id: true, title: true, status: true } },
      dependents: { select: { id: true, title: true, status: true } },
      stageRuns: { orderBy: { startedAt: "asc" } },
      questions: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!task) throw new ApiError(404, "task not found");

  const [plan, prBody, findings] = await Promise.all([
    readArtifact(taskId, "plan.md"),
    readArtifact(taskId, "pr.md"),
    readFindings(taskId),
  ]);

  const tokenTotal = task.stageRuns.reduce(
    (sum, r) => sum + r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheCreationTokens,
    0,
  );

  return {
    id: task.id,
    title: task.title,
    prompt: task.prompt,
    difficulty: task.difficulty,
    status: task.status,
    currentStage: task.currentStage,
    pauseReason: task.pauseReason,
    failureCode: task.failureCode,
    failureDetail: task.failureDetail,
    checklist: (task.checklist as ChecklistItem[] | null) ?? null,
    models: {
      planning: task.planningModel,
      implementation: task.implementationModel,
      review: task.reviewModel,
      testing: task.testingModel,
    },
    skipTesting: task.skipTesting,
    project: {
      id: task.project.id,
      name: task.project.name,
      repoUrl: task.project.repoUrl,
      defaultBranch: task.project.defaultBranch,
    },
    scheduledAt: task.scheduledAt?.toISOString() ?? null,
    dependsOn: task.dependsOn
      ? { id: task.dependsOn.id, title: task.dependsOn.title, status: task.dependsOn.status }
      : null,
    dependents: task.dependents.map((d) => ({ id: d.id, title: d.title, status: d.status })),
    tokenBudget: task.tokenBudget,
    tokenTotal,
    branchName: task.branchName,
    prUrl: task.prUrl,
    reviewCycles: task.reviewCycles,
    testingCycles: task.testingCycles,
    createdAt: task.createdAt.toISOString(),
    startedAt: task.startedAt?.toISOString() ?? null,
    endedAt: task.endedAt?.toISOString() ?? null,
    stageRuns: task.stageRuns.map((r) => ({
      id: r.id,
      stage: r.stage,
      attempt: r.attempt,
      model: r.model,
      status: r.status,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheReadTokens: r.cacheReadTokens,
      cacheCreationTokens: r.cacheCreationTokens,
      startedAt: r.startedAt.toISOString(),
      endedAt: r.endedAt?.toISOString() ?? null,
    })),
    questions: task.questions.map((q) => {
      const items = (q.items as FindingApprovalItem[] | null) ?? null;
      return {
        id: q.id,
        stageRunId: q.stageRunId,
        kind: q.kind,
        text: q.text,
        contextSummary: q.contextSummary,
        options: (q.options as string[] | null) ?? null,
        items,
        approvedNumbers:
          q.kind === "FINDINGS_APPROVAL" && q.status !== "OPEN" && q.answer && items
            ? parseFindingSelection(q.answer, items.filter((i) => !i.auto).length)
            : null,
        status: q.status,
        answer: q.answer,
        answeredVia: q.answeredVia,
        createdAt: q.createdAt.toISOString(),
        answeredAt: q.answeredAt?.toISOString() ?? null,
      };
    }),
    plan,
    prBody,
    findings,
  };
}

async function readArtifact(taskId: string, name: string): Promise<string | null> {
  try {
    return await fs.readFile(artifactPath(taskId, name), "utf8");
  } catch {
    return null;
  }
}

async function readFindings(taskId: string): Promise<FindingsView[]> {
  let names: string[];
  try {
    names = await fs.readdir(artifactDir(taskId));
  } catch {
    return [];
  }
  const out: FindingsView[] = [];
  for (const name of names) {
    const match = /^(review|test)-findings-(\d+)\.json$/.exec(name);
    if (!match) continue;
    const raw = await readArtifact(taskId, name);
    if (!raw) continue;
    try {
      out.push({
        kind: match[1] as "review" | "test",
        attempt: Number(match[2]),
        findings: FindingsSchema.parse(JSON.parse(raw)),
      });
    } catch {
      // ignore malformed findings files
    }
  }
  out.sort((a, b) => (a.kind === b.kind ? a.attempt - b.attempt : a.kind.localeCompare(b.kind)));
  return out;
}
