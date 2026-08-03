"use client";

import type { ReactNode } from "react";

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-zinc-800 p-10 text-center text-sm text-zinc-500 sm:p-12 sm:text-base">
      {children}
    </div>
  );
}
