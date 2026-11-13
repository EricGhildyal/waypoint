import type { UsageWindow } from "./types";

/**
 * The slice of the SDK's `SDKRateLimitInfo` this module reads. `unifiedWindows`
 * is on the wire (Claude Code 2.1.3xx) but not in the SDK's type yet, so
 * everything here is read as unknown and checked.
 */
export interface RateLimitInfoLike {
  rateLimitType?: string;
  utilization?: number;
  resetsAt?: number;
  unifiedWindows?: unknown;
}

/**
 * The SDK reports utilization as a fraction of the window (0.46 = 46% used; a
 * warning arrives with `surpassedThreshold: 0.9`). Everything downstream — the
 * stored readings, the settings bars, the banner — works in percent, and this
 * is the one place the conversion happens.
 */
export function utilizationPercent(fraction: number): number {
  return Math.round(fraction * 1000) / 10;
}

/**
 * An SDK reset time is an epoch of undocumented unit — anything below 1e12 can
 * only be seconds. Returns null when absent or nonsensical.
 */
export function epochToIso(raw: unknown): string | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;
  const date = new Date(raw < 1e12 ? raw * 1000 : raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Every usage-window reading one rate-limit event carries. Newer SDKs send all
 * windows at once in `unifiedWindows`; older ones name only the single binding
 * window, and only on a warning. Both are read, the map taking precedence.
 */
export function usageWindowsFrom(info: RateLimitInfoLike): UsageWindow[] {
  const windows = new Map<string, UsageWindow>();

  if (info.unifiedWindows && typeof info.unifiedWindows === "object") {
    for (const [type, raw] of Object.entries(info.unifiedWindows)) {
      if (!raw || typeof raw !== "object") continue;
      const { utilization, resetsAt } = raw as { utilization?: unknown; resetsAt?: unknown };
      if (typeof utilization !== "number" || !Number.isFinite(utilization)) continue;
      windows.set(type, {
        type,
        utilization: utilizationPercent(utilization),
        resetsAt: epochToIso(resetsAt) ?? undefined,
      });
    }
  }

  if (
    info.rateLimitType &&
    typeof info.utilization === "number" &&
    !windows.has(info.rateLimitType)
  ) {
    windows.set(info.rateLimitType, {
      type: info.rateLimitType,
      utilization: utilizationPercent(info.utilization),
      resetsAt: epochToIso(info.resetsAt) ?? undefined,
    });
  }
  return [...windows.values()];
}
