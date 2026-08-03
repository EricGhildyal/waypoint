"use client";

import clsx from "clsx";
import { useEffect, useId, useRef, useState } from "react";
import { Checkbox } from "./checkbox";
import { ChevronDownIcon } from "./icons";
import { fieldBase } from "./styles";

/**
 * Checkbox dropdown — the multi-value counterpart to Select, wearing the same
 * field chrome. Closes on outside click or Escape; `className` sizes the whole
 * control the way it does on Select.
 */
export function MultiSelect({
  options,
  value,
  onChange,
  placeholder = "All",
  summarize,
  className,
  "aria-label": ariaLabel,
}: {
  options: ReadonlyArray<{ value: string; label: string }>;
  value: string[];
  onChange: (value: string[]) => void;
  /** Shown when nothing is selected. */
  placeholder?: string;
  /** Label for 2+ selections; defaults to "N selected". */
  summarize?: (count: number) => string;
  className?: string;
  "aria-label"?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function toggle(option: string) {
    onChange(value.includes(option) ? value.filter((v) => v !== option) : [...value, option]);
  }

  const summary =
    value.length === 0
      ? placeholder
      : value.length === 1
        ? (options.find((o) => o.value === value[0])?.label ?? placeholder)
        : (summarize?.(value.length) ?? `${value.length} selected`);

  return (
    <div ref={ref} className={clsx("relative", className)}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((o) => !o)}
        className={clsx(
          fieldBase,
          "flex cursor-pointer items-center justify-between gap-2 text-left",
        )}
      >
        <span className={clsx("truncate", value.length === 0 && "text-zinc-400")}>{summary}</span>
        <ChevronDownIcon className="shrink-0 text-zinc-400" />
      </button>

      {open ? (
        <div
          id={listId}
          className="absolute right-0 z-30 mt-1 max-h-80 w-full min-w-56 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900 p-1 shadow-xl"
        >
          {options.map((option) => (
            <label
              key={option.value}
              className="flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-zinc-200 hover:bg-zinc-800"
            >
              <Checkbox
                checked={value.includes(option.value)}
                onChange={() => toggle(option.value)}
              />
              <span className="truncate">{option.label}</span>
            </label>
          ))}
          {value.length ? (
            <button
              type="button"
              onClick={() => onChange([])}
              className="mt-1 w-full cursor-pointer border-t border-zinc-800 px-2.5 pb-1 pt-2 text-left text-xs font-medium text-indigo-400 hover:underline"
            >
              Clear selection
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
