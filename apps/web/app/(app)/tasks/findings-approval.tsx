"use client";

import clsx from "clsx";
import { useState } from "react";
import { useSWRConfig } from "swr";
import { Badge, Button, Checkbox } from "@/components/catalyst";
import { apiFetch } from "@/lib/format";
import type { QuestionView } from "@/lib/task-detail";

const SEVERITY_COLORS = { high: "red", medium: "amber", low: "zinc" } as const;

const CATEGORY_LABELS: Record<string, string> = {
  readability: "readability",
  simplification: "simplification",
  bug: "bug",
  edge_case: "edge case",
  deviation: "plan deviation",
  other: "other",
};

/**
 * The review gate (§7): one checkbox per finding the agent is not allowed to
 * fix on its own authority. Only ticked findings are sent back to the
 * implementation session — everything left unticked is dropped. Readability and
 * simplification findings ride along automatically and are shown read-only.
 *
 * Card-less on purpose: this is the body of the round's `Review cycle N` card
 * (see findings-card.tsx), which supplies the heading and verdict badge.
 */
export function FindingsApproval({ taskId, question }: { taskId: string; question: QuestionView }) {
  const { mutate } = useSWRConfig();
  const items = question.items ?? [];
  const gated = items.filter((item) => !item.auto);
  const auto = items.filter((item) => item.auto);

  // default to fixing everything — the review already judged these worth doing,
  // so the interaction is "untick what you don't want"
  const [approved, setApproved] = useState<number[]>(() =>
    gated.map((item) => item.number).filter((n): n is number => n !== null),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = question.status === "OPEN";

  function toggle(number: number) {
    setApproved((prev) =>
      prev.includes(number) ? prev.filter((n) => n !== number) : [...prev, number],
    );
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/tasks/${taskId}/questions/${question.id}/answer`, {
        method: "POST",
        body: JSON.stringify({ answer: encodeSelection(approved) }),
      });
      await mutate(`/api/tasks/${taskId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (items.length === 0) return null;

  const allSelected = approved.length === gated.length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-zinc-300">
          {gated.length} need{gated.length === 1 ? "s" : ""} your approval
        </p>
        {open ? (
          <button
            type="button"
            className="text-xs font-medium text-indigo-400 hover:underline cursor-pointer"
            onClick={() =>
              setApproved(
                allSelected
                  ? []
                  : gated.map((item) => item.number).filter((n): n is number => n !== null),
              )
            }
          >
            {allSelected ? "Clear all" : "Select all"}
          </button>
        ) : null}
      </div>
      <p className="text-xs text-zinc-500">
        Only the findings you tick get fixed; the rest are dropped and the task moves on.
      </p>

      <ul className="space-y-1.5">
        {gated.map((item) => (
          <li key={item.number}>
            <label
              className={clsx(
                "flex gap-3 rounded-lg bg-zinc-900 p-2.5 text-sm",
                open && "cursor-pointer hover:bg-zinc-800/70",
              )}
            >
              <Checkbox
                className="mt-0.5"
                checked={item.number !== null && approved.includes(item.number)}
                disabled={!open || busy}
                onChange={() => item.number !== null && toggle(item.number)}
              />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <Badge color={SEVERITY_COLORS[item.severity ?? "low"]}>
                    {item.severity ?? "finding"}
                  </Badge>
                  <span className="text-xs text-zinc-500">
                    {CATEGORY_LABELS[item.category] ?? item.category}
                  </span>
                  <code className="truncate text-xs text-zinc-400">{item.file}</code>
                </span>
                <span className="mt-1 block text-zinc-300">{item.description}</span>
                {item.suggestion ? (
                  <span className="mt-1 block text-xs text-zinc-500">💡 {item.suggestion}</span>
                ) : null}
              </span>
            </label>
          </li>
        ))}
      </ul>

      {auto.length ? (
        <div className="rounded-lg border border-zinc-800 p-2.5">
          <p className="text-xs font-medium text-zinc-400">
            Fixed automatically ({auto.length} readability/simplification finding
            {auto.length === 1 ? "" : "s"})
          </p>
          <ul className="mt-1.5 space-y-1">
            {auto.map((item) => (
              <li key={`${item.file}-${item.description}`} className="text-xs text-zinc-500">
                <code className="text-zinc-400">{item.file}</code> — {item.description}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {error ? <p className="text-sm text-red-400">{error}</p> : null}

      {open ? (
        <div className="flex items-center gap-3">
          <Button variant="primary" type="button" loading={busy} onClick={() => void submit()}>
            {approved.length === 0
              ? auto.length
                ? "Skip all — apply auto-fixes only"
                : "Skip all — continue to testing"
              : `Fix ${approved.length} finding${approved.length === 1 ? "" : "s"}`}
          </Button>
          <span className="text-xs text-zinc-500">
            {approved.length}/{gated.length} selected
          </span>
        </div>
      ) : (
        <p className="text-xs text-zinc-500">Answered: {question.answer}</p>
      )}
    </div>
  );
}

/**
 * Local copy of core's encodeFindingSelection — importing the value (rather
 * than the type) would drag Prisma into this client bundle. Must round-trip
 * through parseFindingSelection() in @waypoint/core.
 */
function encodeSelection(approved: number[]): string {
  const sorted = approved.toSorted((a, b) => a - b);
  return `Fix: ${sorted.length ? sorted.join(", ") : "none"}`;
}
