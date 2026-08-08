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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const choiceFor = (child: Dependent): Choice => choices[child.id] ?? "start";

  async function submit() {
    // "Run after…" is only resolvable once a task is picked
    const missing = blockedDependents.some((c) => choiceFor(c) === "after" && !deps[c.id]);
    if (missing) {
      setError("Pick the task to run after.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      // Stop the parent first: a tick that lands mid-dialog then can't start a
      // child off the back of it (and can't start one off a cancelled dep at all).
      await apiFetch(`/api/tasks/${taskId}`, {
        method: "PATCH",
        body: JSON.stringify({ action: "stop" }),
      });
      for (const child of blockedDependents) {
        const choice = choiceFor(child);
        const body =
          choice === "after"
            ? { action: "redepend", dependsOnTaskId: deps[child.id] }
            : { action: choice === "draft" ? "draft" : "start" };
        await apiFetch(`/api/tasks/${child.id}`, { method: "PATCH", body: JSON.stringify(body) });
      }
      await onDone();
      onClose();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
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
                  value={choiceFor(child)}
                  options={CHOICE_OPTIONS}
                  onChange={(value) => setChoices((prev) => ({ ...prev, [child.id]: value }))}
                />
                {choiceFor(child) === "after" ? (
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
