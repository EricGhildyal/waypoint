"use client";

import clsx from "clsx";
import type { ReactNode } from "react";

export function Subheading({ children, className }: { children: ReactNode; className?: string }) {
  return <h2 className={clsx("text-base font-semibold text-zinc-200", className)}>{children}</h2>;
}
