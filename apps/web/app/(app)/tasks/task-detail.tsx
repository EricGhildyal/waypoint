"use client";

import clsx from "clsx";
import { useFormik } from "formik";
import Link from "next/link";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import * as Yup from "yup";
import {
  Badge,
  Button,
  ButtonGroup,
  Card,
  Dialog,
  Field,
  Subheading,
  Tabs,
  Textarea,
} from "@/components/catalyst";
import { ErrorText, fieldError } from "@/components/form-utils";
import { Markdown } from "@/components/markdown";
import { FindingsApproval } from "./findings-approval";
import { BudgetBar, UsageChart } from "./usage-chart";
import {
  STAGE_LABELS,
  STATUS_COLORS,
  STATUS_LABELS,
  apiFetch,
  formatTime,
  formatTokens,
  swrFetcher,
} from "@/lib/format";
import type { QuestionView, TaskDetail } from "@/lib/task-detail";

interface FeedEvent {
  id: string;
  type: string;
  stageRunId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

const PIPELINE_STAGES = ["PLANNING", "IMPLEMENTATION", "REVIEW", "TESTING", "PR"] as const;

export function TaskDetailView({ initial, focus }: { initial: TaskDetail; focus: string | null }) {
  const { mutate } = useSWRConfig();
  const { data } = useSWR<TaskDetail>(`/api/tasks/${initial.id}`, swrFetcher, {
    refreshInterval: 2500,
    fallbackData: initial,
  });
  const task = data ?? initial;

  // event feed with client-side cursor accumulation (§3 cursor)
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const cursorRef = useRef<string | null>(null);
  useEffect(() => {
    let stop = false;
    async function poll() {
      try {
        const query = cursorRef.current ? `?after=${encodeURIComponent(cursorRef.current)}` : "";
        const res = await apiFetch<{ events: FeedEvent[]; cursor: string | null }>(
          `/api/tasks/${initial.id}/events${query}`,
        );
        if (stop) return;
        if (res.events.length) {
          setEvents((prev) => [...prev, ...res.events].slice(-1000));
          cursorRef.current = res.cursor;
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

  const [tab, setTab] = useState(
    focus?.startsWith("question") ? "questions" : focus === "plan" ? "plan" : "activity",
  );
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

  const openQuestions = task.questions.filter((q) => q.status === "OPEN");
  const running = ["PLANNING", "IMPLEMENTING", "REVIEWING", "TESTING"].includes(task.status);
  const pausable = running || ["AWAITING_PLAN_APPROVAL", "NEEDS_INPUT"].includes(task.status);

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
      </div>

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

      <StageStepper task={task} />

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { key: "activity", label: "Activity" },
          { key: "plan", label: "Plan" },
          { key: "checklist", label: "Checklist" },
          { key: "questions", label: "Questions", badge: openQuestions.length },
          { key: "usage", label: "Usage" },
          { key: "findings", label: "Findings" },
        ]}
      />

      {tab === "activity" ? <ActivityTab task={task} events={events} onSteer={action} /> : null}
      {tab === "plan" ? <PlanTab task={task} /> : null}
      {tab === "checklist" ? <ChecklistTab task={task} /> : null}
      {tab === "questions" ? <QuestionsTab task={task} focus={focus} /> : null}
      {tab === "usage" ? <UsageTab task={task} /> : null}
      {tab === "findings" ? <FindingsTab task={task} /> : null}
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

function StageStepper({ task }: { task: TaskDetail }) {
  const currentIndex =
    task.status === "OPENING_PR" || task.status === "DONE"
      ? 4
      : task.currentStage
        ? PIPELINE_STAGES.indexOf(task.currentStage as (typeof PIPELINE_STAGES)[number])
        : -1;
  return (
    // wraps to as many rows as the viewport needs — never scrolls sideways
    <div className="flex flex-wrap items-center gap-x-1 gap-y-2">
      {PIPELINE_STAGES.map((stage, i) => {
        const done = i < currentIndex || task.status === "DONE";
        const active = i === currentIndex && task.status !== "DONE";
        return (
          <div key={stage} className="flex items-center gap-1">
            {/* connectors would strand a dash at the start of a wrapped row */}
            {i > 0 ? <div className="hidden h-px w-4 bg-zinc-700 sm:block" /> : null}
            <div
              className={clsx(
                "whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium sm:text-sm",
                done && "bg-green-500/15 text-green-300",
                active && "bg-indigo-500/20 text-indigo-300 ring-1 ring-indigo-500/40",
                !done && !active && "bg-zinc-800/60 text-zinc-500",
              )}
            >
              {stage === "PR" ? "PR" : STAGE_LABELS[stage]}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ActivityTab({
  task,
  events,
  onSteer,
}: {
  task: TaskDetail;
  events: FeedEvent[];
  onSteer: (name: string, prompt?: string) => Promise<void>;
}) {
  const feedRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length]);

  const active = !["DONE", "CANCELLED", "FAILED"].includes(task.status);

  return (
    <div className="space-y-3">
      <div
        ref={feedRef}
        className="feed-scroll h-96 space-y-1 overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-950 p-3 font-mono text-xs"
      >
        {events.length === 0 ? (
          <p className="text-zinc-600">No events yet…</p>
        ) : (
          events.map((e) => <EventLine key={e.id} event={e} />)
        )}
      </div>
      {task.stageRuns.length ? (
        <p className="text-xs text-zinc-500">
          Full transcripts:{" "}
          {task.stageRuns.map((r, i) => (
            <span key={r.id}>
              {i > 0 ? " · " : ""}
              <a
                className="text-indigo-400 hover:underline"
                href={`/api/tasks/${task.id}/transcript/${r.id}`}
                target="_blank"
                rel="noreferrer"
              >
                {STAGE_LABELS[r.stage] ?? r.stage} #{r.attempt}
              </a>
            </span>
          ))}
        </p>
      ) : null}
      {active ? <SteerForm onSteer={onSteer} /> : null}
    </div>
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

const EVENT_STYLES: Record<string, string> = {
  STATUS_CHANGE: "text-purple-300",
  STAGE_START: "text-sky-300",
  STAGE_END: "text-sky-300",
  ERROR: "text-red-400",
  QUESTION: "text-amber-300",
  ANSWER: "text-green-300",
  STEER: "text-indigo-300",
  PR_OPENED: "text-green-300",
  REVIEW_FINDINGS: "text-cyan-300",
  TEST_FINDINGS: "text-cyan-300",
};

function EventLine({ event }: { event: FeedEvent }) {
  const p = event.payload;
  let text: string;
  switch (event.type) {
    case "STATUS_CHANGE":
      text = `${p.from} → ${p.to}${p.reason ? ` (${p.reason})` : ""}`;
      break;
    case "STAGE_START":
      text = `stage ${p.stage} #${p.attempt} started (${p.model})`;
      break;
    case "STAGE_END":
      text = `stage ${p.stage} #${p.attempt} ended: ${p.status}`;
      break;
    case "LOG":
      text = String(p.line ?? "");
      break;
    case "ERROR":
      text = `${p.code}: ${p.message}`;
      break;
    case "CHECKLIST_UPDATE":
      text = `checklist updated (${Array.isArray(p.items) ? p.items.length : 0} items)`;
      break;
    case "TOKEN_UPDATE":
      text = `tokens: in ${p.inputTokens} out ${p.outputTokens}`;
      break;
    case "REVIEW_FINDINGS":
    case "TEST_FINDINGS":
      text = `${event.type === "REVIEW_FINDINGS" ? "review" : "testing"} #${p.attempt}: ${p.verdict} (${p.count} findings)`;
      break;
    case "STEER":
      text = `steer: ${p.text}`;
      break;
    case "PR_OPENED":
      text = `PR opened: ${p.url}`;
      break;
    case "QUESTION":
      text = "question raised";
      break;
    case "ANSWER":
      text = `answered via ${p.via}`;
      break;
    default:
      text = JSON.stringify(p);
  }
  return (
    <div className="flex gap-2">
      <span className="shrink-0 text-zinc-600">
        {new Date(event.createdAt).toLocaleTimeString(undefined, { hour12: false })}
      </span>
      <span className={clsx("break-all", EVENT_STYLES[event.type] ?? "text-zinc-400")}>{text}</span>
    </div>
  );
}

const RevisionSchema = Yup.object({
  notes: Yup.string().trim().required("Describe the changes you want first"),
});

function PlanTab({ task }: { task: TaskDetail }) {
  const { mutate } = useSWRConfig();
  const [busy, setBusy] = useState(false);
  const planQuestion = task.questions.find(
    (q) => q.kind === "PLAN_APPROVAL" && q.status === "OPEN",
  );

  async function answer(text: string) {
    if (!planQuestion) return;
    await apiFetch(`/api/tasks/${task.id}/questions/${planQuestion.id}/answer`, {
      method: "POST",
      body: JSON.stringify({ answer: text }),
    });
    await mutate(`/api/tasks/${task.id}`);
  }

  // "Request changes" submits revision notes; "Approve" bypasses the form
  const formik = useFormik({
    initialValues: { notes: "" },
    validationSchema: RevisionSchema,
    onSubmit: async (values, helpers) => {
      try {
        await answer(values.notes.trim());
        helpers.resetForm();
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err));
      } finally {
        helpers.setSubmitting(false);
      }
    },
  });

  async function approve() {
    setBusy(true);
    try {
      await answer("approve");
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {task.plan ? (
        <Card>
          <Markdown>{task.plan}</Markdown>
        </Card>
      ) : (
        <Card>
          <p className="text-sm text-zinc-500">No plan yet — planning hasn’t completed.</p>
        </Card>
      )}
      {planQuestion ? (
        <Card className="space-y-3 border-purple-900/50">
          <Subheading>Plan approval required</Subheading>
          <form onSubmit={formik.handleSubmit} noValidate className="space-y-3">
            <div>
              <Textarea
                rows={2}
                className="w-full"
                placeholder="Revision notes (sending them resumes planning)…"
                {...formik.getFieldProps("notes")}
              />
              <ErrorText>{fieldError(formik, "notes")}</ErrorText>
            </div>
            <div className="flex gap-2">
              <Button
                className="flex-1"
                type="button"
                variant="primary"
                disabled={formik.isSubmitting}
                loading={busy}
                onClick={() => void approve()}
              >
                Approve plan
              </Button>
              <Button
                className="flex-1"
                type="submit"
                variant="outline"
                disabled={busy}
                loading={formik.isSubmitting}
              >
                Request changes
              </Button>
            </div>
          </form>
        </Card>
      ) : null}
    </div>
  );
}

function ChecklistTab({ task }: { task: TaskDetail }) {
  if (!task.checklist?.length) {
    return (
      <Card>
        <p className="text-sm text-zinc-500">No checklist yet.</p>
      </Card>
    );
  }
  return (
    <Card>
      <ul className="space-y-1.5">
        {task.checklist.map((item) => (
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
    </Card>
  );
}

function QuestionsTab({ task, focus }: { task: TaskDetail; focus: string | null }) {
  return (
    <div className="space-y-3">
      {task.questions.length === 0 ? (
        <Card>
          <p className="text-sm text-zinc-500">No questions asked yet.</p>
        </Card>
      ) : (
        task.questions.map((q) =>
          // the review gate answers through its own checkbox list (§7), not the
          // free-text form every other question kind uses
          q.kind === "FINDINGS_APPROVAL" && q.items?.length ? (
            <FocusAnchor key={q.id} highlighted={focus === `question-${q.id}`}>
              <FindingsApproval taskId={task.id} question={q} />
            </FocusAnchor>
          ) : (
            <QuestionCard
              key={q.id}
              taskId={task.id}
              question={q}
              highlighted={focus === `question-${q.id}`}
            />
          ),
        )
      )}
    </div>
  );
}

/** Scrolls itself into view when an email's ?focus= deeplink points at it (§8). */
function FocusAnchor({ highlighted, children }: { highlighted: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ block: "center" });
  }, [highlighted]);
  return (
    <div ref={ref} className={clsx(highlighted && "rounded-xl ring-2 ring-indigo-500")}>
      {children}
    </div>
  );
}

const AnswerSchema = Yup.object({
  answer: Yup.string().trim().required("Write an answer first"),
});

function QuestionCard({
  taskId,
  question,
  highlighted,
}: {
  taskId: string;
  question: QuestionView;
  highlighted: boolean;
}) {
  const { mutate } = useSWRConfig();
  const [busy, setBusy] = useState(false);

  async function send(text: string) {
    await apiFetch(`/api/tasks/${taskId}/questions/${question.id}/answer`, {
      method: "POST",
      body: JSON.stringify({ answer: text }),
    });
    await mutate(`/api/tasks/${taskId}`);
  }

  const formik = useFormik({
    initialValues: { answer: "" },
    validationSchema: AnswerSchema,
    onSubmit: async (values, helpers) => {
      try {
        await send(values.answer.trim());
        helpers.resetForm();
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err));
      } finally {
        helpers.setSubmitting(false);
      }
    },
  });

  /** one-click multiple-choice options bypass the free-text form */
  async function submitOption(text: string) {
    setBusy(true);
    try {
      await send(text);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FocusAnchor highlighted={highlighted}>
      <Card className={clsx("space-y-2", question.status === "OPEN" && "border-amber-900/50")}>
        <div className="flex items-center justify-between gap-2">
          <Badge color={question.status === "OPEN" ? "amber" : "green"}>
            {question.kind === "PLAN_APPROVAL" ? "Plan approval" : "Question"} ·{" "}
            {question.status.toLowerCase()}
          </Badge>
          <span className="text-xs text-zinc-500">{formatTime(question.createdAt)}</span>
        </div>
        <p className="whitespace-pre-wrap text-sm text-zinc-200">{question.text}</p>
        {question.contextSummary && question.contextSummary !== question.text ? (
          <p className="text-xs text-zinc-500">{question.contextSummary}</p>
        ) : null}
        {question.status === "OPEN" ? (
          <div className="space-y-2 pt-1">
            {question.options?.length ? (
              // a small set of mutually exclusive answers reads best as a
              // segmented group ("Yes | No"); longer lists stay as loose buttons
              question.options.length <= 3 ? (
                <ButtonGroup
                  full
                  aria-label="Answer options"
                  options={question.options.map((opt) => ({ value: opt, label: opt }))}
                  onChange={(opt) => void submitOption(opt)}
                  disabled={busy || formik.isSubmitting}
                />
              ) : (
                <div className="flex flex-wrap gap-2">
                  {question.options.map((opt) => (
                    <Button
                      key={opt}
                      small
                      type="button"
                      variant="outline"
                      disabled={busy || formik.isSubmitting}
                      onClick={() => void submitOption(opt)}
                    >
                      {opt}
                    </Button>
                  ))}
                </div>
              )
            ) : null}
            <form onSubmit={formik.handleSubmit} noValidate>
              <div className="space-y-2">
                <Textarea rows={2} placeholder="Answer…" {...formik.getFieldProps("answer")} />
                <Button
                  className="w-full"
                  type="submit"
                  variant="primary"
                  disabled={busy}
                  loading={formik.isSubmitting}
                >
                  Send
                </Button>
              </div>
              <ErrorText>{fieldError(formik, "answer")}</ErrorText>
            </form>
          </div>
        ) : (
          <p className="rounded-lg bg-zinc-900 p-2 text-sm text-zinc-300">
            <span className="text-xs text-zinc-500">
              Answered via {question.answeredVia?.toLowerCase() ?? "?"}:{" "}
            </span>
            {question.answer}
          </p>
        )}
      </Card>
    </FocusAnchor>
  );
}

function UsageTab({ task }: { task: TaskDetail }) {
  return (
    <div className="space-y-4">
      {task.tokenBudget ? (
        <Card>
          <BudgetBar total={task.tokenTotal} budget={task.tokenBudget} />
        </Card>
      ) : null}
      {task.stageRuns.length === 0 ? (
        <Card>
          <p className="text-sm text-zinc-500">No stage runs yet.</p>
        </Card>
      ) : (
        <>
          <Card>
            <Subheading className="mb-3">Tokens per stage run</Subheading>
            <UsageChart runs={task.stageRuns} />
          </Card>
          <Card className="overflow-x-auto p-0">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-zinc-800 text-xs uppercase tracking-wide text-zinc-500">
                <tr>
                  {["Stage", "Model", "Status", "Input", "Output", "Cache read", "Cache write"].map(
                    (h) => (
                      <th key={h} className="px-4 py-2 font-medium">
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {task.stageRuns.map((r) => (
                  <tr key={r.id} className="border-b border-zinc-800/60 last:border-0">
                    <td className="px-4 py-2 text-zinc-200">
                      {STAGE_LABELS[r.stage] ?? r.stage} #{r.attempt}
                    </td>
                    <td className="px-4 py-2 text-xs text-zinc-400">{r.model}</td>
                    <td className="px-4 py-2 text-xs text-zinc-400">{r.status}</td>
                    <td className="px-4 py-2 tabular-nums text-zinc-300">
                      {r.inputTokens.toLocaleString()}
                    </td>
                    <td className="px-4 py-2 tabular-nums text-zinc-300">
                      {r.outputTokens.toLocaleString()}
                    </td>
                    <td className="px-4 py-2 tabular-nums text-zinc-300">
                      {r.cacheReadTokens.toLocaleString()}
                    </td>
                    <td className="px-4 py-2 tabular-nums text-zinc-300">
                      {r.cacheCreationTokens.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </div>
  );
}

function FindingsTab({ task }: { task: TaskDetail }) {
  if (task.findings.length === 0) {
    return (
      <Card>
        <p className="text-sm text-zinc-500">No review or test findings yet.</p>
      </Card>
    );
  }
  return (
    <div className="space-y-3">
      {task.findings.map((f) => (
        <Card key={`${f.kind}-${f.attempt}`} className="space-y-2">
          <div className="flex items-center gap-2">
            <Subheading>
              {f.kind === "review" ? "Review" : "Testing"} cycle {f.attempt}
            </Subheading>
            <Badge color={f.findings.verdict === "approve" ? "green" : "amber"}>
              {f.findings.verdict === "approve" ? "Approved" : "Changes requested"}
            </Badge>
          </div>
          {f.findings.findings.length === 0 ? (
            <p className="text-sm text-zinc-500">No findings.</p>
          ) : (
            <ul className="space-y-2">
              {f.findings.findings.map((item) => (
                <li
                  key={`${item.file}-${item.description}`}
                  className="rounded-lg bg-zinc-900 p-2.5 text-sm"
                >
                  <div className="flex items-center gap-2">
                    {item.severity ? (
                      <Badge
                        color={
                          item.severity === "high"
                            ? "red"
                            : item.severity === "medium"
                              ? "amber"
                              : "zinc"
                        }
                      >
                        {item.severity}
                      </Badge>
                    ) : null}
                    <code className="text-xs text-zinc-400">{item.file}</code>
                  </div>
                  <p className="mt-1 text-zinc-300">{item.description}</p>
                  {item.suggestion ? (
                    <p className="mt-1 text-xs text-zinc-500">💡 {item.suggestion}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
      ))}
      <p className="text-xs text-zinc-500">
        Cycles used: review {task.reviewCycles}/3 · testing {task.testingCycles}/2.{" "}
        <Link className="text-indigo-400 hover:underline" href={`/tasks/${task.id}`}>
          ↻
        </Link>
      </p>
    </div>
  );
}
