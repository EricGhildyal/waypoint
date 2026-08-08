import {
  USAGE_WINDOW_TYPES,
  type UsageWindow,
  type UsageWindowType,
  isUsageWindowType,
} from "./schemas";
import { getSetting, setSetting } from "./settings";

const SETTING_KEY = "usageWindows";

/**
 * Backstop expiry for a reading we can't expire any other way. Most readings
 * age out via `resetsAt`, but the SDK sometimes omits it, and such a reading
 * would otherwise sit on the settings page forever ("Extra usage credits — 88%"
 * months after it stopped being true). Longer than the longest real window
 * (7 days) so it never truncates a window that is still meaningful.
 */
const MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000;

/** A stored window reading — a known window type, its percentage, and when we saw it. */
export interface StoredUsageWindow {
  type: UsageWindowType;
  utilization: number;
  resetsAt?: string;
  observedAt: string;
}

type Stored = Partial<Record<UsageWindowType, Omit<StoredUsageWindow, "type">>>;

/**
 * Read the `usageWindows` Setting blob (see recordUsageWindows for the shape).
 * Deliberately defensive — this feeds a page render, so anything unparseable,
 * unknown, expired or stale reads as absent rather than throwing. Returned in
 * USAGE_WINDOW_TYPES order with utilization clamped to 0..100.
 */
export function parseUsageWindows(raw: string): StoredUsageWindow[] {
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const blob = value as Record<string, unknown>;

  const out: StoredUsageWindow[] = [];
  for (const type of USAGE_WINDOW_TYPES) {
    const entry = blob[type];
    if (!entry || typeof entry !== "object") continue;
    const { utilization, resetsAt, observedAt } = entry as Record<string, unknown>;
    if (typeof utilization !== "number" || !Number.isFinite(utilization)) continue;

    const observed = typeof observedAt === "string" ? Date.parse(observedAt) : Number.NaN;
    if (!Number.isFinite(observed)) continue;
    if (Date.now() - observed > MAX_AGE_MS) continue;

    // a rolled-over window's percentage is meaningless — drop it
    const resets = typeof resetsAt === "string" ? Date.parse(resetsAt) : Number.NaN;
    if (Number.isFinite(resets) && resets <= Date.now()) continue;

    out.push({
      type,
      utilization: Math.min(100, Math.max(0, utilization)),
      resetsAt: Number.isFinite(resets) ? (resetsAt as string) : undefined,
      observedAt: observedAt as string,
    });
  }
  return out;
}

/**
 * Merge fresh observations into the `usageWindows` Setting row, keyed by window
 * type, dropping entries whose window has already reset.
 *
 * Merging rather than replacing is essential: the API names only the one window
 * it currently considers binding, so a single sync reports one type and
 * replacing would erase everything else.
 *
 * Two runners can race this read-modify-write and lose one observation. That is
 * fine and intentionally untransacted — this is a display-only cache and every
 * window is re-observed within seconds of the next model turn.
 */
export async function recordUsageWindows(observations: UsageWindow[]): Promise<void> {
  if (!observations.length) return;

  const existing: Stored = {};
  for (const stored of parseUsageWindows(await getSetting(SETTING_KEY))) {
    const { type, ...rest } = stored;
    existing[type] = rest;
  }

  const observedAt = new Date().toISOString();
  for (const obs of observations) {
    // a window name we don't know about is dropped here rather than rejected at
    // the schema — see UsageWindowSchema for why the wire type stays open
    if (!isUsageWindowType(obs.type)) continue;

    const obsResetsAt = obs.resetsAt || undefined;
    const resets = obsResetsAt ? Date.parse(obsResetsAt) : Number.NaN;
    if (Number.isFinite(resets) && resets <= Date.now()) continue;
    // an observation that omits resetsAt keeps the one we already knew, as long
    // as that window has not itself rolled over (parseUsageWindows dropped it if so)
    const resetsAt = obsResetsAt ?? existing[obs.type]?.resetsAt;

    existing[obs.type] = {
      utilization: obs.utilization,
      ...(resetsAt ? { resetsAt } : {}),
      observedAt,
    };
  }

  await setSetting(SETTING_KEY, JSON.stringify(existing));
}
