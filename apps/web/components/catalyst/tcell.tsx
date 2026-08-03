"use client";

import clsx from "clsx";
import type { ReactNode } from "react";

export function TCell({ children, className }: { children: ReactNode; className?: string }) {
  return <td className={clsx("px-4 py-3 align-middle sm:px-5 sm:py-4", className)}>{children}</td>;
}
