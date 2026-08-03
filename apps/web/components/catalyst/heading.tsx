"use client";

import clsx from "clsx";
import type { ReactNode } from "react";

export function Heading({ children, className }: { children: ReactNode; className?: string }) {
  return <h1 className={clsx("text-2xl font-semibold text-zinc-50", className)}>{children}</h1>;
}
