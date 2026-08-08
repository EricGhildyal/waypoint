"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import {
  Button,
  ButtonGroup,
  type ButtonGroupOption,
  Dialog,
  Field,
  Select,
} from "@/components/catalyst";
import { ErrorText } from "@/components/form-utils";
import { STATUS_LABELS, apiFetch, swrFetcher } from "@/lib/format";
import type { TaskListResponse } from "@/lib/task-list";

type Choice = "start" | "after" | "draft";

const CHOICE_OPTIONS: ReadonlyArray<ButtonGroupOption<Choice>> = [
  { value: "start", label: "Start now" },
  { value: "after", label: "Run after…" },
  { value: "draft", label: "Run manually" },
];

const TERMINAL = new Set(["DONE", "FAILED", "CANCELLED"]);

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

interface Dependent {
  id: string;
  title: string;
  status: string;
}

/**
 * Stopping a task strands every task blocked on it — a blocked task now only
 * starts when its dependency reaches DONE, which a cancelled task never will.
 * So the stop asks what to do with each of them first: start it now, wait on a
 * different task instead, or drop it back to a draft the user starts by hand.
 */
export function StopTaskDialog({
  taskId,
  blockedDependents,
  open,
  onClose,
  onDone,
}: {
  taskId: string;
  blockedDependents: Dependent[];
  open: boolean;
  onClose: () => void;
  onDone: () => Promise<void> | void;
}) {
  const { data } = useSWR<TaskListResponse>(open ? "/api/tasks" : null, swrFetcher);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [deps, setDeps] = useState<Record<string, string>>({});
  /** Per-child message, shown under that child; keyed by child id. */
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // the dialog stays mounted, so a close leaves last time's picks and errors
  // behind — start every visit blank
  useEffect(() => {
    if (!open) return;
    setChoices({});
    setDeps({});
    setErrors({});
    setError(null);
  }, [open]);

  async function submit() {
    // Nothing is assumed for a child: there is no default choice (a default of
    // "start" would force-start work whose dependency never finished — the very
    // thing this dialog exists to prevent), and "Run after…" needs its task.
    const missing: Record<string, string> = {};
    for (const child of blockedDependents) {
      const choice = choices[child.id];
      if (!choice) {
        missing[child.id] = "Choose what happens to this task.";
      } else if (choice === "after" && !deps[child.id]) {
        missing[child.id] = "Pick the task to run after.";
      }
    }
    if (Object.keys(missing).length) {
      setErrors(missing);
      setError(null);
      return;
    }
    setErrors({});
    setError(null);
    setBusy(true);

    try {
      // Stop the parent first: a tick that lands mid-dialog then can't start a
      // child off the back of it (and can't start one off a cancelled dep at
      // all). If it fails — the task finished in the moment before the click,
      // so the stop is a 409 — nothing is done to the children: their
      // dependency may well have succeeded, and resolving them here would
      // quietly redirect work that was about to run on its own.
      await apiFetch(`/api/tasks/${taskId}`, {
        method: "PATCH",
        body: JSON.stringify({ action: "stop" }),
      });
    } catch (err) {
      setError(`Couldn’t stop this task: ${message(err)}`);
      setBusy(false);
      await onDone();
      return;
    }

    // Each child is independent: one failure (a child force-started or promoted
    // while the dialog was open answers 409) must not strand the rest, so it is
    // reported next to its child and the others still run.
    const failures: Record<string, string> = {};
    for (const child of blockedDependents) {
      const choice = choices[child.id];
      const body =
        choice === "after"
          ? { action: "redepend", dependsOnTaskId: deps[child.id] }
          : { action: choice === "draft" ? "draft" : "start" };
      try {
        await apiFetch(`/api/tasks/${child.id}`, { method: "PATCH", body: JSON.stringify(body) });
      } catch (err) {
        failures[child.id] = `Couldn’t update this task: ${message(err)}`;
      }
    }

    setBusy(false);
    // the page's 2.5s poll drops resolved children from the list on its own
    await onDone();
    if (Object.keys(failures).length) {
      setErrors(failures);
      return;
    }
    onClose();
  }

  return (
    <Dialog open={open} onClose={onClose} title="Stop task">
      <div className="space-y-4">
        <p className="text-sm text-zinc-400">
          {blockedDependents.length === 1
            ? "One task is blocked on this one and won’t start once it’s cancelled. Choose what happens to it:"
            : `${blockedDependents.length} tasks are blocked on this one and won’t start once it’s cancelled. Choose what happens to each:`}
        </p>

        <div className="feed-scroll max-h-96 space-y-4 overflow-y-auto">
          {blockedDependents.map((child) => (
            <Field key={child.id} label={child.title}>
              <div className="space-y-2">
                <ButtonGroup
                  full
                  small
                  aria-label={`What to do with ${child.title}`}
                  value={choices[child.id]}
                  options={CHOICE_OPTIONS}
                  onChange={(value) => setChoices((prev) => ({ ...prev, [child.id]: value }))}
                />
                {choices[child.id] === "after" ? (
                  <Select
                    value={deps[child.id] ?? ""}
                    onChange={(e) => setDeps((prev) => ({ ...prev, [child.id]: e.target.value }))}
                  >
                    <option value="">Select task…</option>
                    {(data?.tasks ?? [])
                      .filter(
                        (t) => !TERMINAL.has(t.status) && t.id !== taskId && t.id !== child.id,
                      )
                      .map((t) => (
                        <option key={t.id} value={t.id}>
                          {`${t.title} (${STATUS_LABELS[t.status] ?? t.status})`}
                        </option>
                      ))}
                  </Select>
                ) : null}
                <ErrorText>{errors[child.id]}</ErrorText>
              </div>
            </Field>
          ))}
        </div>

        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" variant="danger" loading={busy} onClick={() => void submit()}>
            Stop task
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
