"use client";

import { useState } from "react";
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
  /** Children already resolved by an earlier submit — never replayed. */
  const [resolved, setResolved] = useState<string[]>([]);

  const choiceFor = (child: Dependent): Choice => choices[child.id] ?? "start";

  async function submit() {
    // "Run after…" is only resolvable once a task is picked
    const missing: Record<string, string> = {};
    for (const child of blockedDependents) {
      if (choiceFor(child) === "after" && !deps[child.id]) {
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

    // Every request is independent: one failure (a child force-started or
    // promoted while the dialog was open answers 409) must not strand the rest,
    // so each is reported next to its child and the others still run. A retry
    // skips whatever already succeeded rather than replaying it into a 409.
    const failures: Record<string, string> = {};
    let parentError: string | null = null;
    try {
      // Stop the parent first: a tick that lands mid-dialog then can't start a
      // child off the back of it (and can't start one off a cancelled dep at all).
      await apiFetch(`/api/tasks/${taskId}`, {
        method: "PATCH",
        body: JSON.stringify({ action: "stop" }),
      });
    } catch (err) {
      parentError = `Couldn’t stop this task: ${message(err)}`;
    }

    const done: string[] = [];
    for (const child of blockedDependents) {
      if (resolved.includes(child.id)) continue;
      const choice = choiceFor(child);
      const body =
        choice === "after"
          ? { action: "redepend", dependsOnTaskId: deps[child.id] }
          : { action: choice === "draft" ? "draft" : "start" };
      try {
        await apiFetch(`/api/tasks/${child.id}`, { method: "PATCH", body: JSON.stringify(body) });
        done.push(child.id);
      } catch (err) {
        failures[child.id] = `Couldn’t update this task: ${message(err)}`;
      }
    }

    setResolved((prev) => [...prev, ...done]);
    setBusy(false);
    await onDone();
    if (parentError || Object.keys(failures).length) {
      setError(parentError);
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
                  disabled={resolved.includes(child.id)}
                  aria-label={`What to do with ${child.title}`}
                  value={choiceFor(child)}
                  options={CHOICE_OPTIONS}
                  onChange={(value) => setChoices((prev) => ({ ...prev, [child.id]: value }))}
                />
                {choiceFor(child) === "after" ? (
                  <Select
                    value={deps[child.id] ?? ""}
                    disabled={resolved.includes(child.id)}
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
                {resolved.includes(child.id) ? (
                  <p className="text-xs text-zinc-500">Applied.</p>
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
