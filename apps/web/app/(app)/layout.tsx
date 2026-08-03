import type { ReactNode } from "react";
import { SidebarNav } from "./sidebar-nav";

/** Catalyst sidebar layout shell (§9) — dark only. */
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-full">
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 flex-col border-r border-zinc-800 bg-zinc-950 p-4 lg:flex">
        <div className="mb-6 flex items-center gap-2.5 px-2">
          <span className="flex size-11 items-center justify-center rounded-xl bg-indigo-500/20 text-3xl">
            🧭
          </span>
          <span className="text-base font-semibold tracking-wide text-zinc-100">Waypoint</span>
        </div>
        <SidebarNav />
      </aside>
      <div className="min-w-0 flex-1 lg:pl-60">
        <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-950 px-4 py-3 lg:hidden">
          <span className="text-3xl leading-none">🧭</span>
          <SidebarNav horizontal />
        </div>
        {/* 384 spacing units = 96rem = 1536px */}
        <main className="mx-auto w-full max-w-384 p-5 sm:p-8">{children}</main>
      </div>
    </div>
  );
}
