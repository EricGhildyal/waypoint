"use client";

import clsx from "clsx";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import useSWR from "swr";
import {
  Badge,
  Button,
  EmptyState,
  MultiSelect,
  Select,
  THead,
  TCell,
  TRow,
  Table,
} from "@/components/catalyst";
import {
  STAGE_LABELS,
  STATUS_COLORS,
  STATUS_LABELS,
  formatTime,
  formatTokens,
  swrFetcher,
} from "@/lib/format";
import type { TaskListItem, TaskListResponse } from "@/lib/task-list";

const STATUS_OPTIONS = Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label }));

const RECENT_MS = 3 * 24 * 60 * 60 * 1000;

type SectionKey = "needsAction" | "pending" | "complete";

const SECTIONS: Array<{
  key: SectionKey;
  title: string;
  hint: string;
  accent: string;
  collapsedByDefault: boolean;
}> = [
  {
    key: "needsAction",
    title: "Needs Action",
    hint: "Waiting on you — questions, plan approvals, budget/cycle pauses and recent failures.",
    accent: "bg-red-500",
    collapsedByDefault: false,
  },
  {
    key: "pending",
    title: "Pending",
    hint: "Drafts, queued, scheduled, blocked, rate-limited and everything currently running.",
    accent: "bg-sky-500",
    collapsedByDefault: false,
  },
  {
    key: "complete",
    title: "Complete",
    hint: "Done, cancelled, and failures older than 3 days.",
    accent: "bg-zinc-600",
    collapsedByDefault: true,
  },
];

/**
 * Triage bucket for a task. FAILED splits on age: a fresh failure is something
 * to act on, an old one is just history. PAUSED splits on pauseReason — the
 * budget and cycle-cap pauses are the agent asking you a question, whereas a
 * user-initiated pause is a deliberate state with nothing to answer.
 */
function sectionFor(task: TaskListItem, now: number): SectionKey {
  switch (task.status) {
    case "NEEDS_INPUT":
    case "AWAITING_PLAN_APPROVAL":
      return "needsAction";
    case "PAUSED":
      return task.pauseReason === "BUDGET_EXCEEDED" || task.pauseReason === "CYCLE_CAP"
        ? "needsAction"
        : "pending";
    case "FAILED": {
      const ended = task.endedAt ? Date.parse(task.endedAt) : Date.parse(task.createdAt);
      return now - ended <= RECENT_MS ? "needsAction" : "complete";
    }
    case "DONE":
    case "CANCELLED":
      return "complete";
    // a draft needs a deliberate Start, but it is parked by choice — not a
    // problem to triage, so it sits with the rest of the waiting work
    case "DRAFT":
      return "pending";
    default:
      // QUEUED, SCHEDULED, BLOCKED, RATE_LIMITED, OPENING_PR and the four
      // working statuses all just need time, not attention
      return "pending";
  }
}

/**
 * The sectioned task list, shared by the dashboard and a project's detail page.
 * Pass `projects` to offer the project filter; pass `projectId` to scope the
 * board to one project (which suppresses that filter).
 */
export function TaskBoard({
  initial,
  projects,
  projectId,
  header,
  newTaskHref = "/tasks/new",
}: {
  initial: TaskListResponse;
  /** Omit to hide the project filter (e.g. on a single project's page). */
  projects?: Array<{ id: string; name: string }>;
  /** Fixed project scope — every request and the New Task link inherit it. */
  projectId?: string;
  header?: ReactNode;
  newTaskHref?: string;
}) {
  const [statuses, setStatuses] = useState<string[]>([]);
  const [project, setProject] = useState("");

  const activeProject = projectId ?? project;
  const query = new URLSearchParams();
  if (statuses.length) query.set("status", statuses.join(","));
  if (activeProject) query.set("project", activeProject);

  const filtered = statuses.length > 0 || project !== "";
  const { data } = useSWR<TaskListResponse>(`/api/tasks?${query}`, swrFetcher, {
    refreshInterval: 2500,
    fallbackData: filtered ? undefined : initial,
    keepPreviousData: true,
  });

  const tasks = data?.tasks ?? [];
  const now = Date.now();
  const buckets: Record<SectionKey, TaskListItem[]> = {
    needsAction: [],
    pending: [],
    complete: [],
  };
  for (const task of tasks) buckets[sectionFor(task, now)].push(task);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        {header ?? <span />}
        <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
          <MultiSelect
            aria-label="Filter by status"
            className="w-full sm:w-52"
            options={STATUS_OPTIONS}
            value={statuses}
            onChange={setStatuses}
            placeholder="All statuses"
            summarize={(n) => `${n} statuses`}
          />
          {projects ? (
            <Select
              aria-label="Filter by project"
              className="w-full sm:w-48"
              value={project}
              onChange={(e) => setProject(e.target.value)}
            >
              <option value="">All projects</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          ) : null}
          <Link href={newTaskHref} className="w-full sm:w-auto">
            <Button variant="primary" className="w-full sm:w-auto">
              New Task
            </Button>
          </Link>
        </div>
      </div>

      {tasks.length === 0 ? (
        <EmptyState>
          {filtered ? (
            "No tasks match these filters."
          ) : (
            <>
              No tasks yet.{" "}
              <Link href={newTaskHref} className="text-indigo-400 hover:underline">
                Create the first one
              </Link>
              .
            </>
          )}
        </EmptyState>
      ) : (
        <div className="space-y-5">
          {SECTIONS.map((section) => (
            <TaskSection
              key={section.key}
              title={section.title}
              hint={section.hint}
              accent={section.accent}
              collapsedByDefault={section.collapsedByDefault}
              tasks={buckets[section.key]}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TaskSection({
  title,
  hint,
  accent,
  collapsedByDefault,
  tasks,
}: {
  title: string;
  hint: string;
  accent: string;
  collapsedByDefault: boolean;
  tasks: TaskListItem[];
}) {
  const [open, setOpen] = useState(!collapsedByDefault);
  if (tasks.length === 0) return null;

  return (
    <section className="space-y-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-2.5 text-left"
      >
        <span className={clsx("size-2 shrink-0 rounded-full", accent)} />
        <h2 className="text-lg font-semibold text-zinc-100">{title}</h2>
        <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-xs font-medium text-zinc-300">
          {tasks.length}
        </span>
        <span className="ml-auto text-sm text-zinc-500">{open ? "▾" : "▸"}</span>
      </button>
      {open ? (
        <>
          <p className="text-sm text-zinc-500">{hint}</p>
          <TaskTable tasks={tasks} />
          <TaskCards tasks={tasks} />
        </>
      ) : null}
    </section>
  );
}

function TaskTable({ tasks }: { tasks: TaskListItem[] }) {
  const router = useRouter();
  return (
    <div className="hidden md:block">
      <Table>
        <THead columns={["Task", "Status", "Project", "Stage", "Tokens", "Created"]} />
        <tbody>
          {tasks.map((t) => (
            <TRow key={t.id} onClick={() => router.push(`/tasks/${t.id}`)}>
              <TCell className="max-w-72">
                <div className="truncate font-medium text-zinc-100">{t.title}</div>
                {t.failureCode ? (
                  <div className="truncate text-xs text-red-400">{t.failureCode}</div>
                ) : null}
              </TCell>
              <TCell>
                <Badge color={STATUS_COLORS[t.status] ?? "zinc"}>
                  {STATUS_LABELS[t.status] ?? t.status}
                </Badge>
              </TCell>
              <TCell className="text-zinc-400">{t.projectName}</TCell>
              <TCell className="max-w-64">
                <div className="text-zinc-300">
                  {t.currentStage ? STAGE_LABELS[t.currentStage] : "—"}
                </div>
                {t.currentChecklistItem ? (
                  <div className="truncate text-xs text-zinc-500">{t.currentChecklistItem}</div>
                ) : null}
              </TCell>
              <TCell className="tabular-nums text-zinc-400">{formatTokens(t.tokenTotal)}</TCell>
              <TCell className="whitespace-nowrap text-zinc-500">{formatTime(t.createdAt)}</TCell>
            </TRow>
          ))}
        </tbody>
      </Table>
    </div>
  );
}

function TaskCards({ tasks }: { tasks: TaskListItem[] }) {
  return (
    <div className="space-y-2.5 md:hidden">
      {tasks.map((t) => (
        <Link
          key={t.id}
          href={`/tasks/${t.id}`}
          className="block rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 active:border-zinc-600"
        >
          <div className="flex items-start justify-between gap-2.5">
            <span className="min-w-0 flex-1 font-medium text-zinc-100">{t.title}</span>
            <Badge color={STATUS_COLORS[t.status] ?? "zinc"}>
              {STATUS_LABELS[t.status] ?? t.status}
            </Badge>
          </div>
          <div className="mt-2 flex items-center justify-between text-sm text-zinc-500">
            <span className="truncate">{t.projectName}</span>
            <span className="shrink-0 tabular-nums">{formatTokens(t.tokenTotal)} tok</span>
          </div>
          {t.failureCode ? (
            <div className="mt-1.5 truncate text-sm text-red-400">{t.failureCode}</div>
          ) : null}
          {t.currentChecklistItem ? (
            <div className="mt-1.5 truncate text-sm text-zinc-400">▸ {t.currentChecklistItem}</div>
          ) : null}
        </Link>
      ))}
    </div>
  );
}
