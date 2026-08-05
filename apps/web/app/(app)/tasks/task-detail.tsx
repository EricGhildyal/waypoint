"use client";

import clsx from "clsx";
import { useFormik } from "formik";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import * as Yup from "yup";
import {
  Badge,
  Button,
  ButtonGroup,
  type ButtonGroupOption,
  Card,
  Dialog,
  Field,
  Subheading,
  Textarea,
} from "@/components/catalyst";
import { ErrorText, fieldError } from "@/components/form-utils";
import {
  STAGE_LABELS,
  STATUS_COLORS,
  STATUS_LABELS,
  apiFetch,
  formatTime,
  formatTokens,
  swrFetcher,
} from "@/lib/format";
import type { ChecklistItem } from "@waypoint/core";
import type { TaskDetail } from "@/lib/task-detail";
import { BudgetBar } from "./budget-bar";
import { isHighlight } from "./event-line";
import type { FeedEvent } from "./stage-run-groups";
import { StageRunList } from "./stage-run-list";

// Mobile-only view switcher; desktop shows both columns side by side.
const VIEW_OPTIONS: ReadonlyArray<ButtonGroupOption<"activity" | "checklist">> = [
  { value: "activity", label: "Activity" },
  { value: "checklist", label: "Checklist" },
];

function dedupeAppend(prev: FeedEvent[], next: FeedEvent[]): FeedEvent[] {
  // StrictMode's doubled dev effect can race two pollers over the shared
  // cursor; a Map merge keeps the feed duplicate-free either way
  const merged = new Map(prev.map((e) => [e.id, e]));
  for (const e of next) merged.set(e.id, e);
  return [...merged.values()].slice(-5000);
}

export function TaskDetailView({ initial, focus }: { initial: TaskDetail; focus: string | null }) {
  const { mutate } = useSWRConfig();
  const { data } = useSWR<TaskDetail>(`/api/tasks/${initial.id}`, swrFetcher, {
    refreshInterval: 2500,
    fallbackData: initial,
  });
  const task = data ?? initial;

  // event feed with client-side cursor accumulation (§3 cursor); the inner
  // while-loop catches up on full history in ceil(n/500) requests on first load
  // instead of one 200-event page per 2.5s tick
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const cursorRef = useRef<string | null>(null);
  useEffect(() => {
    let stop = false;
    async function poll() {
      try {
        let fullPage = true;
        while (fullPage) {
          const query = new URLSearchParams({ limit: "500" });
          if (cursorRef.current) query.set("after", cursorRef.current);
          const res = await apiFetch<{ events: FeedEvent[]; cursor: string | null }>(
            `/api/tasks/${initial.id}/events?${query}`,
          );
          if (stop) return;
          fullPage = res.events.length === 500;
          if (res.events.length) {
            // advance the cursor past filtered-out events too, or they'd refetch forever
            cursorRef.current = res.cursor;
            const highlights = res.events.filter(isHighlight);
            if (highlights.length) {
              setEvents((prev) => dedupeAppend(prev, highlights));
            }
          }
        }
      } catch {
        /* transient poll error */
      }
    }
    void poll();
    const timer = setInterval(poll, 2500);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [initial.id]);

  const [view, setView] = useState<"activity" | "checklist">("activity");
  const [busy, setBusy] = useState(false);

  const action = useCallback(
    async (name: string, prompt?: string) => {
      setBusy(true);
      try {
        await apiFetch(`/api/tasks/${task.id}`, {
          method: "PATCH",
          body: JSON.stringify({ action: name, ...(prompt ? { prompt } : {}) }),
        });
        await mutate(`/api/tasks/${task.id}`);
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [task.id, mutate],
  );

  const running = ["PLANNING", "IMPLEMENTING", "REVIEWING", "TESTING"].includes(task.status);
  const pausable = running || ["AWAITING_PLAN_APPROVAL", "NEEDS_INPUT"].includes(task.status);
  const active = !["DONE", "CANCELLED", "FAILED"].includes(task.status);
  // "Start now" queues a draft, and force-queues a scheduled/blocked task ahead
  // of its gate — once queued the time/dependency is no longer waited on.
  const startable = ["DRAFT", "SCHEDULED", "BLOCKED"].includes(task.status);

  return (
    <div className="space-y-4">
      {/* header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-xl font-semibold text-zinc-50">{task.title}</h1>
            <Badge color={STATUS_COLORS[task.status] ?? "zinc"}>
              {STATUS_LABELS[task.status] ?? task.status}
            </Badge>
          </div>
          <p className="mt-0.5 text-sm text-zinc-500">
            {task.project.name} · {task.difficulty.toLowerCase()} · {formatTokens(task.tokenTotal)}{" "}
            tokens
            {task.skipTesting ? " · browser testing skipped" : null}
            {task.branchName ? (
              <>
                {" "}
                · <code className="text-xs">{task.branchName}</code>
              </>
            ) : null}
            {task.prUrl ? (
              <>
                {" · "}
                <a
                  href={task.prUrl}
                  className="text-indigo-400 hover:underline"
                  target="_blank"
                  rel="noreferrer"
                >
                  PR ↗
                </a>
              </>
            ) : null}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {startable ? (
            <Button small variant="primary" disabled={busy} onClick={() => action("start")}>
              Start now
            </Button>
          ) : null}
          {pausable ? (
            <Button small variant="outline" disabled={busy} onClick={() => action("pause")}>
              Pause
            </Button>
          ) : null}
          {task.status === "PAUSED" || task.status === "RATE_LIMITED" ? (
            <Button small variant="primary" disabled={busy} onClick={() => action("resume")}>
              Resume
            </Button>
          ) : null}
          {task.status === "FAILED" ? (
            <RetryButton task={task} busy={busy} onRetry={action} />
          ) : null}
          {!["DONE", "CANCELLED", "FAILED"].includes(task.status) ? (
            <Button
              small
              variant="danger"
              disabled={busy}
              onClick={() => {
                if (confirm("Stop and cancel this task?")) void action("stop");
              }}
            >
              Stop
            </Button>
          ) : null}
        </div>
        {task.tokenBudget ? (
          <div className="w-full sm:ml-auto sm:w-64">
            <BudgetBar total={task.tokenTotal} budget={task.tokenBudget} />
          </div>
        ) : null}
      </div>

      {task.status === "DRAFT" ? (
        <p className="text-sm text-zinc-500">
          Draft — this task won&rsquo;t run until you start it.
        </p>
      ) : null}

      <GateNote task={task} />

      <PromptPanel prompt={task.prompt} />

      {task.status === "FAILED" && task.failureCode ? (
        <Card className="border-red-900/60 bg-red-950/20">
          <p className="text-sm font-medium text-red-300">{task.failureCode}</p>
          {task.failureDetail ? (
            <p className="mt-1 whitespace-pre-wrap text-xs text-red-200/70">{task.failureDetail}</p>
          ) : null}
          <p className="mt-2 text-xs text-zinc-500">
            The container and workspace volume are kept for inspection over SSH. Retry resumes the
            failed stage.
          </p>
        </Card>
      ) : null}

      <ButtonGroup
        full
        small
        className="lg:hidden"
        aria-label="View"
        value={view}
        options={VIEW_OPTIONS}
        onChange={setView}
      />

      <div className="flex flex-col gap-4 lg:flex-row">
        {/* the stage-run list ends at the in-progress row / its open question,
            with the steer box last — newest content at the bottom */}
        <div
          className={clsx("min-w-0 flex-1 space-y-3", view === "checklist" && "hidden lg:block")}
        >
          <StageRunList task={task} events={events} focus={focus} />
          {active ? <SteerForm onSteer={action} /> : null}
        </div>
        <aside className={clsx("lg:w-80 lg:shrink-0", view === "activity" && "hidden lg:block")}>
          <ChecklistPanel items={task.checklist ?? []} />
        </aside>
      </div>
    </div>
  );
}

/**
 * Why this task isn't running yet: the task it waits on and/or the time it
 * starts. Both gates stay on the row after they clear (and "Start now" leaves
 * them there deliberately), so once cleared the same line reads as history.
 */
function GateNote({ task }: { task: TaskDetail }) {
  if (!task.dependsOn && !task.scheduledAt) return null;
  const blocked = task.status === "BLOCKED";
  const scheduled = task.status === "SCHEDULED";

  return (
    <div className="space-y-1 text-sm text-zinc-500">
      {task.dependsOn ? (
        <p>
          {`${blocked ? "Blocked by" : "Depends on"} “`}
          <Link href={`/tasks/${task.dependsOn.id}`} className="text-indigo-400 hover:underline">
            {task.dependsOn.title}
          </Link>
          {`” (${STATUS_LABELS[task.dependsOn.status] ?? task.dependsOn.status})`}
        </p>
      ) : null}
      {task.scheduledAt ? (
        <p>
          {scheduled ? "Starts" : "Was scheduled for"} {formatTime(task.scheduledAt)}
        </p>
      ) : null}
    </div>
  );
}

const RetrySchema = Yup.object({
  prompt: Yup.string().trim().required("The prompt can’t be empty"),
});

/**
 * Retry opens the task's own prompt for editing first (§5 Retry). Saving a
 * changed prompt rewrites Task.prompt, so the resumed stage runs against the
 * revision rather than the prompt that just failed.
 */
function RetryButton({
  task,
  busy,
  onRetry,
}: {
  task: TaskDetail;
  busy: boolean;
  onRetry: (name: string, prompt?: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const formik = useFormik({
    initialValues: { prompt: task.prompt },
    enableReinitialize: true,
    validationSchema: RetrySchema,
    onSubmit: async (values, helpers) => {
      await onRetry("retry", values.prompt.trim());
      helpers.setSubmitting(false);
      setOpen(false);
    },
  });

  function close() {
    formik.resetForm();
    setOpen(false);
  }

  return (
    <>
      <Button small variant="primary" disabled={busy} onClick={() => setOpen(true)}>
        Retry
      </Button>
      <Dialog open={open} onClose={close} title="Retry task">
        <form onSubmit={formik.handleSubmit} noValidate className="space-y-4">
          <p className="text-sm text-zinc-400">
            The {(task.currentStage ? STAGE_LABELS[task.currentStage] : "failed")?.toLowerCase()}{" "}
            stage resumes with the prompt below — edit it first if the failure was the prompt’s
            fault.
          </p>
          <Field label="Task prompt">
            <Textarea rows={10} {...formik.getFieldProps("prompt")} />
            <ErrorText>{fieldError(formik, "prompt")}</ErrorText>
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy} loading={formik.isSubmitting}>
              Go
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

/**
 * Read-only view of the task's prompt, one click away above the stage-run list.
 * It is an uncontrolled <details> so the open/closed state survives the page's
 * 2.5s SWR re-renders without any state plumbing.
 */
function PromptPanel({ prompt }: { prompt: string }) {
  return (
    <details className="rounded-xl border border-zinc-800 bg-zinc-900/50">
      <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold text-zinc-200">
        Prompt
      </summary>
      <div className="border-t border-zinc-800 p-4">
        {prompt.trim() ? (
          // plain text, not markdown: the prompt as the author actually wrote it
          <p className="feed-scroll max-h-80 overflow-y-auto whitespace-pre-wrap wrap-break-word text-sm text-zinc-300">
            {prompt}
          </p>
        ) : (
          <p className="text-sm text-zinc-500">No prompt recorded.</p>
        )}
      </div>
    </details>
  );
}

const SteerSchema = Yup.object({
  text: Yup.string().trim().required("Write a steering message first"),
});

function SteerForm({ onSteer }: { onSteer: (name: string, prompt?: string) => Promise<void> }) {
  const formik = useFormik({
    initialValues: { text: "" },
    validationSchema: SteerSchema,
    onSubmit: async (values, helpers) => {
      await onSteer("steer", values.text.trim());
      helpers.resetForm();
      helpers.setSubmitting(false);
    },
  });
  return (
    <form onSubmit={formik.handleSubmit} noValidate>
      <div className="space-y-2">
        <Textarea
          rows={2}
          placeholder="Steer the agent mid-run — delivered on its next sync…"
          {...formik.getFieldProps("text")}
        />
        <Button className="w-full" variant="primary" type="submit" loading={formik.isSubmitting}>
          Steer
        </Button>
      </div>
      <ErrorText>{fieldError(formik, "text")}</ErrorText>
    </form>
  );
}

/**
 * The checklist owns the sticky right rail on desktop; on mobile it's the
 * second view behind the Activity | Checklist switcher.
 */
function ChecklistPanel({ items }: { items: ChecklistItem[] }) {
  const done = items.filter((i) => i.state === "completed").length;
  return (
    <Card className="lg:sticky lg:top-8">
      <div className="mb-3 flex items-baseline justify-between">
        <Subheading>Checklist</Subheading>
        {items.length ? (
          <span className="text-xs tabular-nums text-zinc-500">
            {done}/{items.length}
          </span>
        ) : null}
      </div>
      <div className="feed-scroll max-h-[calc(100vh-6rem)] overflow-y-auto">
        <ChecklistItems items={items} />
      </div>
    </Card>
  );
}

function ChecklistItems({ items }: { items: ChecklistItem[] }) {
  if (!items.length) {
    return <p className="text-sm text-zinc-500">No checklist yet.</p>;
  }
  return (
    <ul className="space-y-1.5">
      {items.map((item) => (
        <li key={item.text} className="flex items-start gap-2 text-sm">
          <span className="mt-0.5">
            {item.state === "completed" ? "✅" : item.state === "in_progress" ? "🔄" : "⬜"}
          </span>
          <span
            className={clsx(
              item.state === "completed" && "text-zinc-500 line-through",
              item.state === "in_progress" && "text-zinc-100",
              item.state === "pending" && "text-zinc-400",
            )}
          >
            {item.text}
          </span>
        </li>
      ))}
    </ul>
  );
}
