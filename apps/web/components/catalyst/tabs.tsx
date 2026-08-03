"use client";

import clsx from "clsx";
import { Select } from "./select";

export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: Array<{ key: string; label: string; badge?: number }>;
  active: string;
  onChange: (key: string) => void;
}) {
  return (
    <>
      {/* mobile: a select, the way GitHub collapses its tab bars */}
      <Select
        aria-label="Select a tab"
        className="sm:hidden"
        value={active}
        onChange={(e) => onChange(e.target.value)}
      >
        {tabs.map((tab) => (
          <option key={tab.key} value={tab.key}>
            {tab.badge ? `${tab.label} (${tab.badge})` : tab.label}
          </option>
        ))}
      </Select>

      <div className="hidden gap-1 overflow-x-auto border-b border-zinc-800 sm:flex">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => onChange(tab.key)}
            className={clsx(
              "flex cursor-pointer items-center gap-1.5 whitespace-nowrap border-b-2 px-3.5 py-2.5 text-sm font-medium transition-colors",
              active === tab.key
                ? "border-indigo-500 text-zinc-50"
                : "border-transparent text-zinc-500 hover:text-zinc-300",
            )}
          >
            {tab.label}
            {tab.badge ? (
              <span className="rounded-full bg-red-500/20 px-1.5 text-xs text-red-300">
                {tab.badge}
              </span>
            ) : null}
          </button>
        ))}
      </div>
    </>
  );
}
