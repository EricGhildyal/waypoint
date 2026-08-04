import { NextResponse } from "next/server";
import { getSetting } from "@waypoint/core";
import { apiError, requireUser } from "@/lib/api";

/** A warning older than this is assumed stale — runners stop reporting when idle. */
const WARNING_TTL_MS = 30 * 60 * 1000;

export interface RateLimitStatus {
  /** Non-null while the shared Claude Max window is exhausted. */
  paused: { resetsAt: string } | null;
  /** Non-null while the SDK reports `allowed_warning` and we are not paused. */
  warning: { utilization?: number } | null;
}

/**
 * GET /api/rate-limit — global Claude usage state for the top-of-page banner.
 * Both settings are only ever superseded, never deleted, so anything in the
 * past (or stale) reads as "no limit".
 */
export async function GET() {
  try {
    await requireUser();
    const [resetsAtRaw, warningRaw] = await Promise.all([
      getSetting("rateLimitResetsAt"),
      getSetting("rateLimitWarning"),
    ]);

    const resetsAt = Date.parse(resetsAtRaw);
    if (Number.isFinite(resetsAt) && resetsAt > Date.now()) {
      return NextResponse.json({
        paused: { resetsAt: new Date(resetsAt).toISOString() },
        warning: null,
      } satisfies RateLimitStatus);
    }

    return NextResponse.json({
      paused: null,
      warning: parseWarning(warningRaw),
    } satisfies RateLimitStatus);
  } catch (err) {
    return apiError(err);
  }
}

function parseWarning(raw: string): RateLimitStatus["warning"] {
  if (!raw) return null;
  let value: { utilization?: number; resetsAt?: string; reportedAt?: string };
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const reportedAt = Date.parse(value.reportedAt ?? "");
  if (!Number.isFinite(reportedAt) || Date.now() - reportedAt > WARNING_TTL_MS) return null;
  // the window the warning was about has since reset
  const windowEnd = Date.parse(value.resetsAt ?? "");
  if (Number.isFinite(windowEnd) && windowEnd <= Date.now()) return null;
  return { utilization: typeof value.utilization === "number" ? value.utilization : undefined };
}
