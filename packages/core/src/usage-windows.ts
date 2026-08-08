import { USAGE_WINDOW_TYPES, type UsageWindow, type UsageWindowType } from "./schemas";
import { getSetting, setSetting } from "./settings";

const SETTING_KEY = "usageWindows";

/** A stored window reading — a `UsageWindow` plus when we last saw it. */
export interface StoredUsageWindow extends UsageWindow {
  observedAt: string;
}

type Stored = Partial<Record<UsageWindowType, Omit<StoredUsageWindow, "type">>>;

/**
 * Read the `usageWindows` Setting blob (see recordUsageWindows for the shape).
 * Deliberately defensive — this feeds a page render, so anything unparseable,
 * unknown or expired reads as absent rather than throwing. Returned in
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
    const { utilization, resetsAt, status, observedAt } = entry as Record<string, unknown>;
    if (typeof utilization !== "number" || !Number.isFinite(utilization)) continue;
    if (typeof observedAt !== "string" || Number.isNaN(Date.parse(observedAt))) continue;
    // a rolled-over window's percentage is meaningless — drop it
    const resets = typeof resetsAt === "string" ? Date.parse(resetsAt) : Number.NaN;
    if (Number.isFinite(resets) && resets <= Date.now()) continue;
    out.push({
      type,
      utilization: Math.min(100, Math.max(0, utilization)),
      resetsAt: Number.isFinite(resets) ? (resetsAt as string) : undefined,
      status:
        status === "allowed" || status === "allowed_warning" || status === "rejected"
          ? status
          : undefined,
      observedAt,
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
  for (const window of parseUsageWindows(await getSetting(SETTING_KEY))) {
    const { type, ...rest } = window;
    existing[type] = rest;
  }

  const observedAt = new Date().toISOString();
  for (const obs of observations) {
    const resets = obs.resetsAt ? Date.parse(obs.resetsAt) : Number.NaN;
    if (Number.isFinite(resets) && resets <= Date.now()) continue;
    existing[obs.type] = {
      utilization: obs.utilization,
      ...(obs.resetsAt ? { resetsAt: obs.resetsAt } : {}),
      ...(obs.status ? { status: obs.status } : {}),
      observedAt,
    };
  }

  await setSetting(SETTING_KEY, JSON.stringify(existing));
}
