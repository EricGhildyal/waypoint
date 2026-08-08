"use client";

import type { StoredUsageWindow, UsageWindowType } from "@waypoint/core";
import { useEffect, useState } from "react";
import { Card, EmptyState, Subheading } from "@/components/catalyst";
import { formatTime } from "@/lib/format";

/**
 * Claude plan limits as percentage bars, in the style of Claude Code's /usage.
 *
 * Readings are recorded from the SDK's `rate_limit_event`s while a task runs,
 * and the API names only the window it currently considers binding — so the
 * list fills in over time and individual windows age at very different rates.
 * `five_hour` is re-observed constantly; a weekly window may be days stale.
 * Hence a per-bar timestamp once a reading gets old, not just one summary line.
 */

// The SDK still uses the Opus/Sonnet names for the per-model weekly windows;
// `seven_day_opus` is the top-tier weekly window, which on this account is Fable.
const LABELS: Record<UsageWindowType, { title: string; hint?: string }> = {
  five_hour: { title: "Current session", hint: "5-hour window" },
  seven_day: { title: "Current week (all models)" },
  seven_day_opus: { title: "Current week (Fable)" },
  seven_day_sonnet: { title: "Current week (Sonnet)" },
  seven_day_overage_included: { title: "Current week (extra usage)" },
  overage: { title: "Extra usage credits" },
};

/** Past this, a bar carries its own "seen" time so a stale weekly window can't hide. */
const STALE_AFTER_MS = 60 * 60 * 1000;

export function UsageLimitsCard({ windows }: { windows: StoredUsageWindow[] }) {
  const now = useNow();

  return (
    <Card className="space-y-4">
      <Subheading>Claude usage</Subheading>
      {windows.length === 0 ? (
        <EmptyState>
          No usage data yet — Waypoint records your Claude limit windows while a task is running.
        </EmptyState>
      ) : (
        <>
          <div className="space-y-3">
            {windows.map((usage) => (
              <UsageBar key={usage.type} usage={usage} now={now} />
            ))}
          </div>
          <p className="text-xs text-zinc-500">
            Last reading {now ? formatTime(newestObservedAt(windows)) : "—"} — recorded while a task
            is running.
          </p>
        </>
      )}
    </Card>
  );
}

/**
 * Client clock, so locale/timezone-formatted timestamps and the staleness
 * comparison never differ between SSR and hydration (the server's zone is not
 * the browser's). Starts null so both renders match, then fills in on mount —
 * same pattern as useNow in tasks/stage-run-list.tsx.
 */
function useNow(): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => setNow(Date.now()), []);
  return now;
}

/** Most recent reading across all windows. ISO strings sort lexicographically. */
function newestObservedAt(windows: StoredUsageWindow[]): string {
  let newest = "";
  for (const usage of windows) if (usage.observedAt > newest) newest = usage.observedAt;
  return newest;
}

/** Validated dark palette: calm below half, amber approaching, critical red at 80%+. */
function fillColor(pct: number): string {
  if (pct >= 80) return "#d03b3b";
  if (pct >= 50) return "#c98500";
  return "#3987e5";
}

function UsageBar({ usage, now }: { usage: StoredUsageWindow; now: number | null }) {
  const pct = Math.round(usage.utilization);
  const label = LABELS[usage.type].title;
  const hint = LABELS[usage.type].hint;
  const stale = now !== null && now - Date.parse(usage.observedAt) > STALE_AFTER_MS;

  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="text-zinc-400">
          {label}
          {hint ? <span className="text-zinc-500"> · {hint}</span> : null}
        </span>
        <span className="text-zinc-400 tabular-nums">{pct}%</span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-2 overflow-hidden rounded-full bg-zinc-800"
      >
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${pct}%`, backgroundColor: fillColor(pct) }}
        />
      </div>
      {now && (usage.resetsAt || stale) ? (
        <p className="mt-1 text-xs text-zinc-500">
          {usage.resetsAt ? `Resets ${formatTime(usage.resetsAt)}` : null}
          {usage.resetsAt && stale ? " · " : null}
          {stale ? `seen ${formatTime(usage.observedAt)}` : null}
        </p>
      ) : null}
    </div>
  );
}
