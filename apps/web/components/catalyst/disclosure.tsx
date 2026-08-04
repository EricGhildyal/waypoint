"use client";

import clsx from "clsx";
import type { ReactNode } from "react";
import { ChevronDownIcon } from "./icons";

/**
 * Controlled disclosure row — the GitHub-Actions-style expandable section.
 * Controlled (`open`/`onToggle`) rather than `<details>` so callers can apply
 * default-expansion rules and deeplink-driven expansion. `disabled` renders the
 * header without a chevron and ignores clicks (placeholder rows).
 */
export function Disclosure({
  open,
  onToggle,
  header,
  children,
  disabled = false,
  className,
  bodyClassName,
}: {
  open: boolean;
  onToggle: () => void;
  header: ReactNode;
  children?: ReactNode;
  disabled?: boolean;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <div
      className={clsx(
        "overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/50",
        className,
      )}
    >
      <button
        type="button"
        disabled={disabled}
        aria-expanded={open}
        onClick={onToggle}
        className={clsx(
          "flex w-full items-center gap-2 px-4 py-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500",
          disabled ? "cursor-default" : "cursor-pointer hover:bg-zinc-900/80",
        )}
      >
        <div className="min-w-0 flex-1">{header}</div>
        {disabled ? null : (
          <ChevronDownIcon
            className={clsx("shrink-0 text-zinc-500 transition-transform", open && "rotate-180")}
          />
        )}
      </button>
      {open && !disabled ? (
        <div className={clsx("border-t border-zinc-800", bodyClassName)}>{children}</div>
      ) : null}
    </div>
  );
}
