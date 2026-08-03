"use client";

import clsx from "clsx";
import type { ReactNode } from "react";

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={clsx("rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 sm:p-5", className)}>
      {children}
    </div>
  );
}
