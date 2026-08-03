"use client";

import clsx from "clsx";
import type { InputHTMLAttributes } from "react";

/** Tailwind UI checkbox: `appearance-none` box, checkmark drawn by the sibling SVG. */
export function Checkbox({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <span className={clsx("group grid size-4 shrink-0 grid-cols-1", className)}>
      <input
        {...props}
        type="checkbox"
        className="col-start-1 row-start-1 appearance-none rounded border border-zinc-600 bg-zinc-900 checked:border-indigo-500 checked:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 disabled:border-zinc-700 disabled:bg-zinc-800 cursor-pointer disabled:cursor-not-allowed"
      />
      <svg
        viewBox="0 0 14 14"
        fill="none"
        aria-hidden="true"
        className="pointer-events-none col-start-1 row-start-1 size-3.5 self-center justify-self-center stroke-white opacity-0 group-has-checked:opacity-100"
      >
        <path d="M3 8L6 11L11 3.5" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
