"use client";

/**
 * Usage tab chart: one thin stacked horizontal bar per StageRun, four fixed
 * token-type series. Palette = validated dark categorical slots 1–4 (passes
 * CVD/contrast checks on the zinc-900 surface); identity is carried by the
 * legend + per-segment tooltips, and the token table below is the table view.
 */
import { formatTokens } from "@/lib/format";
import type { StageRunView } from "@/lib/task-detail";

const SERIES = [
  { key: "inputTokens", label: "Input", color: "#3987e5" },
  { key: "outputTokens", label: "Output", color: "#d95926" },
  { key: "cacheReadTokens", label: "Cache read", color: "#199e70" },
  { key: "cacheCreationTokens", label: "Cache write", color: "#c98500" },
] as const;

const STAGE_SHORT: Record<string, string> = {
  PLANNING: "Plan",
  IMPLEMENTATION: "Impl",
  REVIEW: "Review",
  TESTING: "Test",
};

export function UsageChart({ runs }: { runs: StageRunView[] }) {
  const totals = runs.map((r) => SERIES.reduce((sum, s) => sum + r[s.key], 0));
  const max = Math.max(...totals, 1);

  return (
    <div>
      {/* legend — identity is never color-alone; labels use text ink */}
      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1">
        {SERIES.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5 text-xs text-zinc-400">
            <span className="size-2.5 rounded-sm" style={{ backgroundColor: s.color }} />
            {s.label}
          </span>
        ))}
      </div>

      <div className="space-y-2">
        {runs.map((run, i) => {
          const total = totals[i] ?? 0;
          return (
            <div key={run.id} className="flex items-center gap-3">
              <span className="w-24 shrink-0 text-right text-xs text-zinc-500">
                {STAGE_SHORT[run.stage] ?? run.stage} #{run.attempt}
              </span>
              <div className="h-4 min-w-0 flex-1">
                {total > 0 ? (
                  <div
                    className="flex h-full items-stretch gap-0.5"
                    style={{ width: `${Math.max((total / max) * 100, 2)}%` }}
                  >
                    {SERIES.filter((s) => run[s.key] > 0).map((s, idx, visible) => (
                      <div
                        key={s.key}
                        title={`${s.label}: ${run[s.key].toLocaleString()} tokens`}
                        className={
                          idx === visible.length - 1
                            ? "rounded-r-[4px]"
                            : idx === 0
                              ? "rounded-l-[1px]"
                              : ""
                        }
                        style={{
                          backgroundColor: s.color,
                          flexGrow: run[s.key],
                          flexBasis: 0,
                          minWidth: 2,
                        }}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="h-full w-0.5 bg-zinc-800" />
                )}
              </div>
              <span className="w-14 shrink-0 text-right text-xs tabular-nums text-zinc-400">
                {formatTokens(total)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Budget meter — single-hue fill; switches to the critical status color when exceeded. */
export function BudgetBar({ total, budget }: { total: number; budget: number }) {
  const pct = Math.min((total / budget) * 100, 100);
  const over = total > budget;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="text-zinc-400">Budget</span>
        <span className={over ? "font-medium text-red-400" : "text-zinc-400"}>
          {formatTokens(total)} / {formatTokens(budget)}
          {over ? " — exceeded" : ""}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${pct}%`, backgroundColor: over ? "#d03b3b" : "#3987e5" }}
        />
      </div>
    </div>
  );
}
