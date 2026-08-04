import type { StateStore } from "./state";
import type { ChecklistItem, TrackedItem } from "./types";

type ItemState = ChecklistItem["state"];

const STATES = new Set<string>(["pending", "in_progress", "completed"]);

/** The tool calls the tracker folds in; anything else is ignored outright. */
export const TRACKED_TOOLS = new Set<string>(["TodoWrite", "TaskCreate", "TaskUpdate", "TaskList"]);

/** Drop the tracked list — a fresh Agent SDK session starts a fresh task list. */
export function clearChecklistTracker(state: StateStore): void {
  state.update({ checklistTracker: [] });
}

/**
 * Folds the agent's progress-tracking tool calls into a single checklist
 * snapshot for the host (§6 checklist sync).
 *
 * The SDK ships two tool families for this: the legacy `TodoWrite` (whole-list
 * snapshots) and the task tracker (`TaskCreate`/`TaskUpdate`/`TaskList`
 * deltas). Which one an agent reaches for depends on the SDK build, so the
 * tracker watches every tool call and understands both — the checklist keeps
 * advancing either way.
 *
 * Entries live in the durable runner state, so a container restart mid-stage
 * resumes with the list it already had instead of resetting to all-pending.
 */
export class ChecklistTracker {
  private items: TrackedItem[];

  constructor(private readonly state: StateStore) {
    this.items = [...(state.get().checklistTracker ?? [])];
  }

  /**
   * Feed one PostToolUse observation in. Returns the new checklist snapshot
   * when the list changed, or null when the tool was of no interest.
   */
  record(toolName: string, toolInput: unknown, toolResponse: unknown): ChecklistItem[] | null {
    switch (toolName) {
      case "TodoWrite":
        return this.onTodoWrite(toolInput);
      case "TaskCreate":
        return this.onTaskCreate(toolInput, toolResponse);
      case "TaskUpdate":
        return this.onTaskUpdate(toolInput);
      case "TaskList":
        return this.onTaskList(toolResponse);
      default:
        return null;
    }
  }

  // --- tool handlers -------------------------------------------------------

  /** TodoWrite carries the whole list every time — replace wholesale. */
  private onTodoWrite(toolInput: unknown): ChecklistItem[] | null {
    const todos = record(toolInput)?.todos;
    if (!Array.isArray(todos)) return null;
    this.items = todos
      .map((todo, i) => {
        const t = record(todo);
        return { id: `todo-${i}`, text: text(t?.content), state: toState(t?.status) };
      })
      .filter((item) => item.text);
    return this.commit();
  }

  private onTaskCreate(toolInput: unknown, toolResponse: unknown): ChecklistItem[] | null {
    const id = createdTaskId(toolResponse);
    const subject = text(record(toolInput)?.subject);
    if (!id || !subject) return null;

    // Task ids are per-session sequence numbers, so an id we already hold can
    // only mean the agent's list restarted (a fix-up round resumes the session
    // but numbers its tasks from #1 again). Drop that entry and everything
    // after it: those are the previous round's leftovers, and keeping them
    // would leave stale text collecting the new round's checkmarks.
    const clash = this.items.findIndex((item) => item.id === id);
    if (clash >= 0) this.items.splice(clash);

    this.items.push({ id, text: subject, state: "pending" });
    return this.commit();
  }

  private onTaskUpdate(toolInput: unknown): ChecklistItem[] | null {
    const input = record(toolInput);
    const id = text(input?.taskId);
    const index = this.items.findIndex((item) => item.id === id);
    const current = this.items[index];
    if (!current) return null; // an id we never saw created — nothing to update

    const status = input?.status;
    if (status === "deleted") {
      this.items.splice(index, 1);
      return this.commit();
    }
    const subject = text(input?.subject);
    const next: TrackedItem = {
      ...current,
      ...(subject ? { text: subject } : {}),
      ...(isState(status) ? { state: status } : {}),
    };
    if (next.text === current.text && next.state === current.state) return null;
    this.items[index] = next;
    return this.commit();
  }

  /** TaskList is authoritative — it resyncs us after any call we missed. */
  private onTaskList(toolResponse: unknown): ChecklistItem[] | null {
    const tasks = record(unwrap(toolResponse))?.tasks;
    if (!Array.isArray(tasks)) return null;
    this.items = tasks
      .map((task) => {
        const t = record(task);
        return { id: text(t?.id), text: text(t?.subject), state: toState(t?.status) };
      })
      .filter((item) => item.id && item.text);
    return this.commit();
  }

  // --- plumbing ------------------------------------------------------------

  /**
   * Persist the new list and hand back a snapshot to send — except an empty
   * one. The host replaces `Task.checklist` wholesale, so pushing `[]` (the
   * agent listing an empty task list, deleting its last task, or clearing its
   * todos) would blank the panel, including the plan-seeded checkboxes that
   * are all it has to show before the agent starts tracking. Keep the last
   * non-empty checklist on screen instead.
   */
  private commit(): ChecklistItem[] | null {
    this.persist();
    if (!this.items.length) return null;
    return this.items.map(({ text: t, state: s }) => ({ text: t, state: s }));
  }

  private persist(): void {
    this.state.update({ checklistTracker: this.items });
  }
}

// --- unknown-shaped hook payload helpers -----------------------------------

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

function isState(value: unknown): value is ItemState {
  return typeof value === "string" && STATES.has(value);
}

function toState(value: unknown): ItemState {
  return isState(value) ? value : "pending";
}

/**
 * Tool responses reach the hook either as the tool's structured output or as
 * the rendered `{ content: [{ type: "text", text }] }` block the model sees.
 * Unwrap the former out of the latter when we get the latter.
 */
function unwrap(response: unknown): unknown {
  const content = record(response)?.content;
  if (!Array.isArray(content)) return response;
  for (const block of content) {
    const raw = record(block)?.text;
    if (typeof raw !== "string") continue;
    try {
      return JSON.parse(raw);
    } catch {
      /* not JSON — nothing to unwrap */
    }
  }
  return response;
}

/**
 * The id TaskCreate handed back, which is what later TaskUpdate calls key off.
 * Structured output is `{ task: { id } }`; the rendered form is the string
 * "Task #3 created successfully: <subject>".
 */
function createdTaskId(response: unknown): string {
  const unwrapped = unwrap(response);
  const structured = text(record(record(unwrapped)?.task)?.id);
  if (structured) return structured;

  const rendered = typeof unwrapped === "string" ? unwrapped : renderedText(unwrapped);
  return /Task #(\S+) created/.exec(rendered)?.[1] ?? "";
}

function renderedText(response: unknown): string {
  const content = record(response)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => text(record(block)?.text)).join("\n");
}
