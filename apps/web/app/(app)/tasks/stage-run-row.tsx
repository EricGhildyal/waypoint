"use client";

import { Fragment, type ReactNode } from "react";
import {
  Card,
  CheckIcon,
  CircleOutlineIcon,
  Disclosure,
  MinusIcon,
  Spinner,
  Subheading,
  XMarkIcon,
} from "@/components/catalyst";
import { Markdown } from "@/components/markdown";
import { STAGE_LABELS, formatDuration, formatTokens } from "@/lib/format";
import type { QuestionView, StageRunView, TaskDetail } from "@/lib/task-detail";
import { EventLine } from "./event-line";
import { FindingsApproval } from "./findings-approval";
import { FindingsCard } from "./findings-card";
import { FocusAnchor } from "./focus-anchor";
import { PlanSection } from "./plan-section";
import { QuestionCard } from "./question-card";
import type { FeedEvent, RowItem, Section } from "./stage-run-groups";
import { TokenMixBar } from "./token-mix-bar";

/**
 * One GitHub-Actions-style section of the task page: a stage run, the Setup
 * stragglers, the PR wrap-up, or a grayed not-started placeholder.
 */
export function SectionRow({
  task,
  section,
  open,
  onToggle,
  focus,
  now,
  showPlan = false,
}: {
  task: TaskDetail;
  section: Section;
  open: boolean;
  onToggle: () => void;
  focus: string | null;
  /** Mount-gated client clock for running rows — null during SSR/hydration. */
  now: string | null;
  /** True only for the latest PLANNING run — the one that owns plan.md. */
  showPlan?: boolean;
}) {
  switch (section.kind) {
    case "placeholder":
      return (
        <Disclosure
          disabled
          open={false}
          onToggle={() => {}}
          className="opacity-60"
          header={
            <RowHeader
              icon={<CircleOutlineIcon className="text-zinc-600" />}
              label={
                section.stage === "PR" ? "Open PR" : (STAGE_LABELS[section.stage] ?? section.stage)
              }
              muted
              meta={<span className="text-xs text-zinc-600">not started</span>}
            />
          }
        />
      );
    case "setup":
      return (
        <Disclosure
          open={open}
          onToggle={onToggle}
          header={
            <RowHeader
              icon={<CircleOutlineIcon className="text-zinc-500" />}
              label="Setup"
              meta={
                <span className="text-xs text-zinc-500">
                  {section.items.length} event{section.items.length === 1 ? "" : "s"}
                </span>
              }
            />
          }
          bodyClassName="space-y-3 p-4"
        >
          <ItemFeed taskId={task.id} items={section.items} focus={focus} />
        </Disclosure>
      );
    case "pr": {
      const opened = Boolean(task.prUrl);
      return (
        <Disclosure
          open={open}
          onToggle={onToggle}
          header={
            <RowHeader
              icon={
                opened || task.status === "DONE" ? (
                  <CheckIcon className="text-green-400" />
                ) : (
                  <span aria-hidden="true">
                    <Spinner className="text-indigo-400" />
                  </span>
                )
              }
              label="Open PR"
              meta={opened ? null : <span className="text-xs text-zinc-500">opening…</span>}
            />
          }
          bodyClassName="space-y-3 p-4"
        >
          <ItemFeed taskId={task.id} items={section.items} focus={focus} />
          {task.prUrl ? (
            <p className="text-sm">
              <a
                href={task.prUrl}
                target="_blank"
                rel="noreferrer"
                className="text-indigo-400 hover:underline"
              >
                {task.prUrl} ↗
              </a>
            </p>
          ) : null}
          {task.prBody ? (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
              <Markdown>{task.prBody}</Markdown>
            </div>
          ) : null}
        </Disclosure>
      );
    }
    case "run": {
      const { run } = section;
      // The review gate and the review findings artifact describe the same
      // round, so they render as one card (see FindingsCard). Take the newest
      // gate in the section; a rare second one keeps rendering inline in the
      // feed. If the artifact is missing or malformed there is nothing to merge
      // into, so the question stays in the feed rather than becoming
      // unanswerable.
      const approvalQuestion = section.items.reduce<QuestionView | null>(
        (found, item) =>
          item.kind === "question" &&
          item.question.kind === "FINDINGS_APPROVAL" &&
          item.question.items?.length
            ? item.question
            : found,
        null,
      );
      const merged =
        approvalQuestion && section.findings.some((f) => f.kind === "review")
          ? approvalQuestion
          : null;
      return (
        <Disclosure
          open={open}
          onToggle={onToggle}
          header={<RunHeader run={run} now={now} />}
          bodyClassName="space-y-3 p-4"
        >
          <ItemFeed
            taskId={task.id}
            items={section.items}
            focus={focus}
            hiddenQuestionId={merged?.id ?? null}
          />
          {showPlan ? <PlanSection task={task} focus={focus} /> : null}
          {section.findings.map((f) => {
            const approval = f.kind === "review" ? merged : null;
            const card = (
              <FindingsCard
                taskId={task.id}
                view={f}
                cyclesUsed={f.kind === "review" ? task.reviewCycles : task.testingCycles}
                approval={approval}
              />
            );
            const key = `${f.kind}-${f.attempt}`;
            // keeps the ?focus=question-{id} email deeplink landing on the
            // approval UI now that it lives inside this card
            return approval ? (
              <FocusAnchor key={key} highlighted={focus === `question-${approval.id}`}>
                {card}
              </FocusAnchor>
            ) : (
              <Fragment key={key}>{card}</Fragment>
            );
          })}
          <p className="text-xs text-zinc-500">
            <a
              className="text-indigo-400 hover:underline"
              href={`/api/tasks/${task.id}/transcript/${run.id}`}
              target="_blank"
              rel="noreferrer"
            >
              raw transcript ↗
            </a>
          </p>
        </Disclosure>
      );
    }
  }
}

function RunHeader({ run, now }: { run: StageRunView; now: string | null }) {
  const total = run.inputTokens + run.outputTokens + run.cacheReadTokens + run.cacheCreationTokens;
  const durationEnd = run.endedAt ?? (run.status === "RUNNING" ? now : null);
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      <StatusIcon status={run.status} />
      <span className="truncate text-sm font-medium text-zinc-200">
        {STAGE_LABELS[run.stage] ?? run.stage} <span className="text-zinc-500">#{run.attempt}</span>
      </span>
      {run.status === "RUNNING" ? <span className="text-xs text-indigo-300">running</span> : null}
      {durationEnd ? (
        <span className="text-xs tabular-nums text-zinc-500">
          {formatDuration(run.startedAt, durationEnd)}
        </span>
      ) : null}
      <span className="ml-auto flex items-center gap-2">
        <TokenMixBar run={run} className="hidden sm:flex" />
        <span className="text-xs tabular-nums text-zinc-400">{formatTokens(total)}</span>
      </span>
    </span>
  );
}

function RowHeader({
  icon,
  label,
  meta,
  muted = false,
}: {
  icon: ReactNode;
  label: string;
  meta?: ReactNode;
  muted?: boolean;
}) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      {icon}
      <span
        className={
          muted
            ? "truncate text-sm font-medium text-zinc-500"
            : "truncate text-sm font-medium text-zinc-200"
        }
      >
        {label}
      </span>
      {meta ? <span className="ml-auto">{meta}</span> : null}
    </span>
  );
}

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case "RUNNING":
      // decorative here — the header text says "running"; the spinner's own
      // role="status" label would otherwise prefix the row's accessible name
      return (
        <span aria-hidden="true">
          <Spinner className="text-indigo-400" />
        </span>
      );
    case "SUCCEEDED":
      return <CheckIcon className="text-green-400" />;
    case "FAILED":
      return <XMarkIcon className="text-red-400" />;
    case "INTERRUPTED":
      return <MinusIcon className="text-amber-400" />;
    default:
      return <CircleOutlineIcon className="text-zinc-600" />;
  }
}

type Chunk =
  | { kind: "events"; key: string; events: FeedEvent[] }
  | { kind: "question"; question: QuestionView };

/**
 * A row's chronological body: consecutive event lines merge into one monospace
 * log block; question cards break the flow inline where they were asked.
 */
function ItemFeed({
  taskId,
  items,
  focus,
  hiddenQuestionId = null,
}: {
  taskId: string;
  items: RowItem[];
  focus: string | null;
  /** The review gate merged into this row's FindingsCard, if any. */
  hiddenQuestionId?: string | null;
}) {
  // Plan approvals never render as question cards — the PlanSection carries the
  // plan markdown and its approve/request-changes form instead. Same for the
  // review gate that FindingsCard has absorbed.
  const visible = items.filter(
    (item) =>
      item.kind !== "question" ||
      (item.question.kind !== "PLAN_APPROVAL" && item.question.id !== hiddenQuestionId),
  );
  if (!visible.length) return null;
  const chunks: Chunk[] = [];
  for (const item of visible) {
    if (item.kind === "event") {
      const last = chunks[chunks.length - 1];
      if (last?.kind === "events") last.events.push(item.event);
      else chunks.push({ kind: "events", key: item.event.id, events: [item.event] });
    } else {
      chunks.push({ kind: "question", question: item.question });
    }
  }
  return (
    <div className="space-y-3">
      {chunks.map((chunk) =>
        chunk.kind === "events" ? (
          <div key={chunk.key} className="space-y-1 rounded-lg bg-zinc-950 p-3 font-mono text-xs">
            {chunk.events.map((e) => (
              <EventLine key={e.id} event={e} />
            ))}
          </div>
        ) : // the review gate answers through its own checkbox list (§7), not the
        // free-text form every other question kind uses. Fallback only: normally
        // this renders inside the round's FindingsCard, but a missing or
        // malformed findings artifact leaves nothing to merge into.
        chunk.question.kind === "FINDINGS_APPROVAL" && chunk.question.items?.length ? (
          <FocusAnchor
            key={chunk.question.id}
            highlighted={focus === `question-${chunk.question.id}`}
          >
            <Card className="space-y-3 border-amber-900/50">
              <Subheading>Review findings</Subheading>
              <FindingsApproval taskId={taskId} question={chunk.question} />
            </Card>
          </FocusAnchor>
        ) : (
          <QuestionCard
            key={chunk.question.id}
            taskId={taskId}
            question={chunk.question}
            highlighted={focus === `question-${chunk.question.id}`}
          />
        ),
      )}
    </div>
  );
}
