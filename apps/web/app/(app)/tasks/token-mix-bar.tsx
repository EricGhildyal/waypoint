"use client";

/**
 * Fixed-width stacked token-mix bar for a stage-run row header: every run gets
 * the same-width bar, segments show that run's input/output/cache proportions.
 * Palette = validated dark categorical slots 1–4 (passes CVD/contrast checks on
 * the zinc-900 surface); the full breakdown rides the title tooltip.
 */
import clsx from "clsx";
import type { StageRunView } from "@/lib/task-detail";

export const SERIES = [
  { key: "inputTokens", label: "Input", color: "#3987e5" },
  { key: "outputTokens", label: "Output", color: "#d95926" },
  { key: "cacheReadTokens", label: "Cache read", color: "#199e70" },
  { key: "cacheCreationTokens", label: "Cache write", color: "#c98500" },
] as const;

export function TokenMixBar({ run, className }: { run: StageRunView; className?: string }) {
  const total = SERIES.reduce((sum, s) => sum + run[s.key], 0);
  return (
    <span
      title={SERIES.map((s) => `${s.label}: ${run[s.key].toLocaleString()} tokens`).join(" · ")}
      className={clsx(
        "flex h-2.5 w-28 shrink-0 items-stretch gap-px overflow-hidden rounded-full",
        className,
      )}
    >
      {total > 0 ? (
        SERIES.filter((s) => run[s.key] > 0).map((s) => (
          <span
            key={s.key}
            style={{ backgroundColor: s.color, flexGrow: run[s.key], flexBasis: 0, minWidth: 1 }}
          />
        ))
      ) : (
        <span className="w-full bg-zinc-800" />
      )}
    </span>
  );
}
