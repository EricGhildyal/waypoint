"use client";

import { formatTokens } from "@/lib/format";

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
