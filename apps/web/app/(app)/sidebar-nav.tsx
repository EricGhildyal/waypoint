"use client";

import clsx from "clsx";
import Link from "next/link";
import { usePathname } from "next/navigation";
import useSWR from "swr";
import type { TaskListResponse } from "@/lib/task-list";
import { swrFetcher } from "@/lib/format";

const LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/projects", label: "Projects" },
  { href: "/settings", label: "Settings" },
];

/** Sidebar with live badge counts — SWR polling, no sockets (§9). */
export function SidebarNav({ horizontal = false }: { horizontal?: boolean }) {
  const pathname = usePathname();
  const { data } = useSWR<TaskListResponse>("/api/tasks", swrFetcher, {
    refreshInterval: 2500,
  });

  return (
    <nav
      className={clsx(
        horizontal ? "flex min-w-0 flex-1 gap-1 overflow-x-auto" : "flex flex-col gap-1",
      )}
    >
      {LINKS.map((link) => {
        const active =
          link.href === "/"
            ? pathname === "/" || pathname.startsWith("/tasks")
            : pathname.startsWith(link.href);
        return (
          <Link
            key={link.href}
            href={link.href}
            className={clsx(
              "flex items-center justify-between gap-2 whitespace-nowrap rounded-lg px-3.5 py-2 text-base font-medium transition-colors",
              active
                ? "bg-zinc-800/80 text-zinc-50"
                : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200",
            )}
          >
            <span>{link.label}</span>
            {link.href === "/" && data ? (
              <span className="flex items-center gap-1">
                {data.counts.needsInput > 0 ? (
                  <span className="rounded-full bg-red-500/20 px-1.5 text-xs font-semibold text-red-300">
                    {data.counts.needsInput}
                  </span>
                ) : null}
                {data.counts.running > 0 ? (
                  <span className="rounded-full bg-sky-500/20 px-1.5 text-xs text-sky-300">
                    {data.counts.running}
                  </span>
                ) : null}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
