"use client";

import clsx from "clsx";
import type { ReactNode } from "react";

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={clsx("overflow-x-auto rounded-xl border border-zinc-800", className)}>
      <table className="w-full text-left text-sm sm:text-[0.9375rem]">{children}</table>
    </div>
  );
}
