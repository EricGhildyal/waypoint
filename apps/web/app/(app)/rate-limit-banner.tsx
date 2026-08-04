"use client";

import useSWR from "swr";
import { swrFetcher } from "@/lib/format";

interface RateLimitStatus {
  paused: { resetsAt: string } | null;
  warning: { utilization?: number } | null;
}

/**
 * Global Claude usage banner (§5). Two states: an early warning while the SDK
 * reports it is approaching the window, then "all tasks are paused until X"
 * once the window is exhausted — X in the browser's local time.
 */
export function RateLimitBanner() {
  const { data } = useSWR<RateLimitStatus>("/api/rate-limit", swrFetcher, {
    refreshInterval: 30_000,
  });
  if (!data) return null;

  const resetsAt = data.paused ? new Date(data.paused.resetsAt) : null;
  // re-checked on every render so the banner drops the moment the window
  // passes, without waiting for the next poll
  if (resetsAt && resetsAt.getTime() > Date.now()) {
    return (
      <Banner>
        ⚠ All tasks are paused until {formatLocal(resetsAt)} — Claude usage limit reached
      </Banner>
    );
  }

  if (data.warning) {
    const pct = data.warning.utilization;
    return (
      <Banner>
        ⚠ Claude usage{pct === undefined ? " is high" : ` at ~${Math.round(pct)}%`} — tasks will
        pause soon
      </Banner>
    );
  }
  return null;
}

function Banner({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-b border-yellow-600 bg-yellow-500/15 px-4 py-2 text-center text-sm font-medium text-yellow-300">
      {children}
    </div>
  );
}

/** Local-time reset moment; the date is included when it isn't today (weekly windows). */
function formatLocal(date: Date): string {
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const isToday = date.toDateString() === new Date().toDateString();
  if (isToday) return time;
  return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}
