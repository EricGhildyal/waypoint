import { db } from "@waypoint/core";
import type { ChecklistItem, TaskStatus } from "@waypoint/core";

export interface TaskListItem {
  id: string;
  title: string;
  status: string;
  difficulty: string;
  projectId: string;
  projectName: string;
  currentStage: string | null;
  currentChecklistItem: string | null;
  failureCode: string | null;
  pauseReason: string | null;
  prUrl: string | null;
  tokenTotal: number;
  createdAt: string;
  /** Set on DONE / FAILED / CANCELLED — drives the board's "recent" split. */
  endedAt: string | null;
}

export interface TaskListResponse {
  tasks: TaskListItem[];
  counts: { needsInput: number; running: number; failed: number };
}

const TASK_STATUSES = new Set([
  "QUEUED",
  "SCHEDULED",
  "BLOCKED",
  "PLANNING",
  "AWAITING_PLAN_APPROVAL",
  "IMPLEMENTING",
  "REVIEWING",
  "TESTING",
  "NEEDS_INPUT",
  "PAUSED",
  "RATE_LIMITED",
  "OPENING_PR",
  "DONE",
  "FAILED",
  "CANCELLED",
]);

export async function getTaskList(filter: {
  /** One status, or several comma-separated; unknown values are dropped. */
  status?: string;
  projectId?: string;
}): Promise<TaskListResponse> {
  const statuses = (filter.status ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => TASK_STATUSES.has(s)) as TaskStatus[];
  const where = {
    ...(statuses.length ? { status: { in: statuses } } : {}),
    ...(filter.projectId ? { projectId: filter.projectId } : {}),
  };
  const [tasks, sums, needsInput, running, failed] = await Promise.all([
    db.task.findMany({
      where,
      include: { project: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
    db.stageRun.groupBy({
      by: ["taskId"],
      _sum: {
        inputTokens: true,
        outputTokens: true,
        cacheReadTokens: true,
        cacheCreationTokens: true,
      },
    }),
    db.task.count({ where: { status: { in: ["NEEDS_INPUT", "AWAITING_PLAN_APPROVAL"] } } }),
    db.task.count({
      where: { status: { in: ["PLANNING", "IMPLEMENTING", "REVIEWING", "TESTING", "OPENING_PR"] } },
    }),
    db.task.count({ where: { status: "FAILED" } }),
  ]);

  const totals = new Map(
    sums.map((s) => [
      s.taskId,
      (s._sum.inputTokens ?? 0) +
        (s._sum.outputTokens ?? 0) +
        (s._sum.cacheReadTokens ?? 0) +
        (s._sum.cacheCreationTokens ?? 0),
    ]),
  );

  return {
    tasks: tasks.map((t) => {
      const checklist = (t.checklist as ChecklistItem[] | null) ?? [];
      const current = checklist.find((i) => i.state === "in_progress") ?? null;
      return {
        id: t.id,
        title: t.title,
        status: t.status,
        difficulty: t.difficulty,
        projectId: t.projectId,
        projectName: t.project.name,
        currentStage: t.currentStage,
        currentChecklistItem: current?.text ?? null,
        failureCode: t.failureCode,
        pauseReason: t.pauseReason,
        prUrl: t.prUrl,
        tokenTotal: totals.get(t.id) ?? 0,
        createdAt: t.createdAt.toISOString(),
        endedAt: t.endedAt?.toISOString() ?? null,
      };
    }),
    counts: { needsInput, running, failed },
  };
}
