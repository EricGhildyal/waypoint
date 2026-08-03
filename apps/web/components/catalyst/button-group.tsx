"use client";

import clsx from "clsx";
import type { ReactNode } from "react";

export interface ButtonGroupOption<T extends string> {
  value: T;
  label: ReactNode;
}

/**
 * Segmented control — a joined row of mutually exclusive choices ("Yes | No").
 * `value` may be undefined, which renders every segment unselected; that's the
 * shape used for one-shot pickers like an agent question's answer options.
 */
export function ButtonGroup<T extends string>({
  options,
  value,
  onChange,
  disabled = false,
  full = false,
  small = false,
  className,
  "aria-label": ariaLabel,
}: {
  options: ReadonlyArray<ButtonGroupOption<T>>;
  value?: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  /** Stretch to the container's width, splitting it evenly between segments. */
  full?: boolean;
  small?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={clsx(
        "isolate inline-flex divide-x divide-zinc-700 overflow-hidden rounded-lg border border-zinc-700",
        full && "flex w-full",
        className,
      )}
    >
      {options.map((option) => {
        const selected = value !== undefined && option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            disabled={disabled}
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
            className={clsx(
              "cursor-pointer text-center font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-60",
              small ? "px-3 py-1.5 text-xs" : "px-4 py-2 text-sm",
              full && "flex-1",
              selected
                ? "bg-indigo-500 text-white hover:bg-indigo-400"
                : "bg-zinc-900 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** The `"true"` / `"false"` string pair every boolean Setting is stored as. */
export const YES_NO_OPTIONS: ReadonlyArray<ButtonGroupOption<string>> = [
  { value: "true", label: "Yes" },
  { value: "false", label: "No" },
];
