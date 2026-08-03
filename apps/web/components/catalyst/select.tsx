"use client";

import clsx from "clsx";
import type { SelectHTMLAttributes } from "react";
import { ChevronDownIcon } from "./icons";
import { fieldBase } from "./styles";

/**
 * `className` lands on the wrapper, not the `<select>` — the select is always
 * `w-full` so a caller's width class sizes the whole control (chevron included).
 */
export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className={clsx("relative", className)}>
      <select {...props} className={clsx(fieldBase, "cursor-pointer appearance-none pr-9")}>
        {children}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400" />
    </div>
  );
}
