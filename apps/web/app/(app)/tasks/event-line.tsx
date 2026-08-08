"use client";

import clsx from "clsx";
import { STAGE_LABELS, STATUS_LABELS } from "@/lib/format";
import type { FeedEvent } from "./stage-run-groups";

// The feed shows pipeline-level highlights plus the model's own narration and
// task-level notes (LOG lines tagged source: assistant/thinking/system);
// tool-call and command spam (untagged LOG debug/info, TOKEN_UPDATE) stays in
// the stage transcripts.
// CHECKLIST_UPDATE is omitted because the checklist is always visible beside
// the feed.
const HIGHLIGHT_TYPES = new Set([
  "STATUS_CHANGE",
  "STAGE_START",
  "STAGE_END",
  "QUESTION",
  "ANSWER",
  "STEER",
  "PROMPT_UPDATED",
  "ERROR",
  "REVIEW_FINDINGS",
  "TEST_FINDINGS",
  "PR_OPENED",
]);

export function isHighlight(event: FeedEvent): boolean {
  if (HIGHLIGHT_TYPES.has(event.type)) return true;
  if (event.type !== "LOG") return false;
  const { source, level } = event.payload;
  return (
    source === "assistant" ||
    source === "thinking" ||
    source === "system" ||
    level === "warn" ||
    level === "error"
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
  PROMPT_UPDATED: "text-indigo-300",
  PR_OPENED: "text-green-300",
  REVIEW_FINDINGS: "text-cyan-300",
  TEST_FINDINGS: "text-cyan-300",
};

export function EventLine({ event }: { event: FeedEvent }) {
  const p = event.payload;
  let text: string;
  switch (event.type) {
    case "STATUS_CHANGE":
      text = `${STATUS_LABELS[String(p.from)] ?? p.from} → ${STATUS_LABELS[String(p.to)] ?? p.to}${p.reason ? ` (${p.reason})` : ""}`;
      break;
    case "STAGE_START":
      text = `${STAGE_LABELS[String(p.stage)] ?? p.stage} #${p.attempt} started (${p.model})`;
      break;
    case "STAGE_END":
      text = `${STAGE_LABELS[String(p.stage)] ?? p.stage} #${p.attempt} ended: ${p.status}`;
      break;
    case "LOG":
      // only assistant/thinking/system notes and warn/error lines pass the filter
      text = `${p.source === "thinking" ? "💭 " : ""}${String(p.line ?? "")}`;
      break;
    case "ERROR":
      text = `${p.code}: ${p.message}`;
      break;
    case "REVIEW_FINDINGS":
    case "TEST_FINDINGS":
      text = `${event.type === "REVIEW_FINDINGS" ? "review" : "testing"} #${p.attempt}: ${p.verdict} (${p.count} findings)`;
      break;
    case "STEER":
      text = `steer: ${p.text}`;
      break;
    case "PROMPT_UPDATED":
      text = "task prompt updated";
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
  const style = event.type === "LOG" ? logStyle(p) : (EVENT_STYLES[event.type] ?? "text-zinc-400");
  // narration is prose — wrap on word boundaries; everything else stays break-all
  const isProse = event.type === "LOG" && (p.source === "assistant" || p.source === "thinking");
  return (
    <div className="flex gap-2">
      <span className="shrink-0 text-zinc-600">
        {new Date(event.createdAt).toLocaleTimeString(undefined, { hour12: false })}
      </span>
      <span className={clsx(isProse ? "whitespace-pre-wrap wrap-break-word" : "break-all", style)}>
        {text}
      </span>
    </div>
  );
}

function logStyle(p: Record<string, unknown>): string {
  if (p.source === "thinking") return "italic text-zinc-500";
  if (p.source === "assistant") return "text-zinc-200";
  // a note about the task itself, not a warning — don't paint it yellow
  if (p.source === "system") return "text-zinc-400";
  return p.level === "error" ? "text-red-400" : "text-yellow-300";
}
