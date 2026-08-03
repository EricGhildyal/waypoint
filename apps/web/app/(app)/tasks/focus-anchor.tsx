"use client";

import clsx from "clsx";
import { type ReactNode, useEffect, useRef } from "react";

/** Scrolls itself into view when an email's ?focus= deeplink points at it (§8). */
export function FocusAnchor({
  highlighted,
  children,
}: {
  highlighted: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ block: "center" });
  }, [highlighted]);
  return (
    <div ref={ref} className={clsx(highlighted && "rounded-xl ring-2 ring-indigo-500")}>
      {children}
    </div>
  );
}
