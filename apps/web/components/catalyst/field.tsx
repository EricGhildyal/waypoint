"use client";

import clsx from "clsx";
import type { ReactNode } from "react";

export function Field({
  label,
  hint,
  children,
  className,
  group = false,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
  /**
   * Set when the child is a group of buttons rather than one input. A <label>
   * activates its first control on click, so clicking the caption or hint
   * would press the first button; a group gets a plain wrapper instead.
   */
  group?: boolean;
}) {
  const Tag = group ? "div" : "label";
  return (
    <Tag className={clsx("block", className)}>
      <span className="mb-1 block text-xs font-medium text-zinc-400">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-zinc-500">{hint}</span> : null}
    </Tag>
  );
}
