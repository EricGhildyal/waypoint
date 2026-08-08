"use client";

import type { StoredUsageWindow, UsageWindowType } from "@waypoint/core";
import { Card, EmptyState, Subheading } from "@/components/catalyst";
import { formatTime } from "@/lib/format";

/**
 * Claude plan limits as percentage bars, in the style of Claude Code's /usage.
 *
 * Readings are recorded from the SDK's `rate_limit_event`s while a task runs,
 * and the API names only the window it currently considers binding — so the
 * list fills in over time and can be stale. Hence the "last updated" line.
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

export function UsageLimitsCard({ windows }: { windows: StoredUsageWindow[] }) {
  const lastUpdated = windows
    .map((w) => w.observedAt)
    .toSorted()
    .at(-1);

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
            {windows.map((window) => (
              <UsageBar
                key={window.type}
                label={LABELS[window.type].title}
                hint={LABELS[window.type].hint}
                window={window}
              />
            ))}
          </div>
          {lastUpdated ? (
            <p className="text-xs text-zinc-500">
              Last updated {formatTime(lastUpdated)} — recorded while a task is running.
            </p>
          ) : null}
        </>
      )}
    </Card>
  );
}

/** Validated dark palette: calm below half, amber approaching, critical red at 80%+. */
function fillColor(pct: number): string {
  if (pct >= 80) return "#d03b3b";
  if (pct >= 50) return "#c98500";
  return "#3987e5";
}

function UsageBar({
  label,
  hint,
  window,
}: {
  label: string;
  hint?: string;
  window: StoredUsageWindow;
}) {
  const pct = Math.round(window.utilization);
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
      {window.resetsAt ? (
        <p className="mt-1 text-xs text-zinc-500">Resets {formatTime(window.resetsAt)}</p>
      ) : null}
    </div>
  );
}
