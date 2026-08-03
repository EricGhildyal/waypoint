import type { BadgeColor } from "@/components/catalyst";

export const STATUS_COLORS: Record<string, BadgeColor> = {
  QUEUED: "zinc",
  SCHEDULED: "zinc",
  BLOCKED: "amber",
  PLANNING: "blue",
  AWAITING_PLAN_APPROVAL: "purple",
  IMPLEMENTING: "sky",
  REVIEWING: "indigo",
  TESTING: "cyan",
  NEEDS_INPUT: "purple",
  PAUSED: "amber",
  RATE_LIMITED: "orange",
  OPENING_PR: "teal",
  DONE: "green",
  FAILED: "red",
  CANCELLED: "zinc",
};

export const STATUS_LABELS: Record<string, string> = {
  QUEUED: "Queued",
  SCHEDULED: "Scheduled",
  BLOCKED: "Blocked",
  PLANNING: "Planning",
  AWAITING_PLAN_APPROVAL: "Plan approval",
  IMPLEMENTING: "Implementing",
  REVIEWING: "Reviewing",
  TESTING: "Testing",
  NEEDS_INPUT: "Needs input",
  PAUSED: "Paused",
  RATE_LIMITED: "Rate limited",
  OPENING_PR: "Opening PR",
  DONE: "Done",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
};

export const STAGE_LABELS: Record<string, string> = {
  PLANNING: "Planning",
  IMPLEMENTATION: "Implementation",
  REVIEW: "Review",
  TESTING: "Testing",
};

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Compact elapsed time between two instants: "34s", "12m 4s", "1h 07m". */
export function formatDuration(startIso: string, endIso: string): string {
  const totalSeconds = Math.max(
    0,
    Math.floor((new Date(endIso).getTime() - new Date(startIso).getTime()) / 1000),
  );
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export async function apiFetch<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    let message = `${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* keep status */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

// SWR fetcher — typed loosely so `useSWR<T>` picks the response type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const swrFetcher = (url: string): Promise<any> => apiFetch(url);
