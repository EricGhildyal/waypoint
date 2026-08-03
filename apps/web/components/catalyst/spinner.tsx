"use client";

import clsx from "clsx";

/**
 * The Tailwind UI spinner: a quarter-opacity track with a 75%-opacity arc,
 * spun by `animate-spin`. Inherits the current text color, so it works on any
 * button variant and inside body copy.
 */
export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={clsx("size-4 animate-spin", className)}
      viewBox="0 0 24 24"
      fill="none"
      role="status"
      aria-label="Loading"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}
