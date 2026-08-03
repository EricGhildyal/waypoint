"use client";

import clsx from "clsx";

export function Divider({ className }: { className?: string }) {
  return <hr className={clsx("border-zinc-800", className)} />;
}
