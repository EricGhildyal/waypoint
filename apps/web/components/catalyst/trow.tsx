"use client";

import clsx from "clsx";
import type { ReactNode } from "react";

export function TRow({
  children,
  onClick,
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <tr
      onClick={onClick}
      className={clsx(
        "border-b border-zinc-800/60 last:border-0",
        onClick && "cursor-pointer hover:bg-zinc-900",
        className,
      )}
    >
      {children}
    </tr>
  );
}
