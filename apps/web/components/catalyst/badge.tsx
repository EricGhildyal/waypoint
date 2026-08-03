"use client";

import clsx from "clsx";
import type { ReactNode } from "react";

export const badgeColors = {
  zinc: "bg-zinc-500/15 text-zinc-300 ring-zinc-500/30",
  blue: "bg-blue-500/15 text-blue-300 ring-blue-500/30",
  sky: "bg-sky-500/15 text-sky-300 ring-sky-500/30",
  indigo: "bg-indigo-500/15 text-indigo-300 ring-indigo-500/30",
  cyan: "bg-cyan-500/15 text-cyan-300 ring-cyan-500/30",
  purple: "bg-purple-500/15 text-purple-300 ring-purple-500/30",
  amber: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  orange: "bg-orange-500/15 text-orange-300 ring-orange-500/30",
  red: "bg-red-500/15 text-red-300 ring-red-500/30",
  green: "bg-green-500/15 text-green-300 ring-green-500/30",
  teal: "bg-teal-500/15 text-teal-300 ring-teal-500/30",
} as const;

export type BadgeColor = keyof typeof badgeColors;

export function Badge({
  color = "zinc",
  className,
  children,
}: {
  color?: BadgeColor;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset whitespace-nowrap",
        badgeColors[color],
        className,
      )}
    >
      {children}
    </span>
  );
}
