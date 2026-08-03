"use client";

import type { ReactNode } from "react";

export function Dialog({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        aria-label="Close"
        className="absolute inset-0 bg-black/70"
        onClick={onClose}
        type="button"
      />
      <div className="relative z-10 w-full max-w-lg rounded-xl border border-zinc-700 bg-zinc-900 p-5 shadow-2xl">
        <h3 className="mb-4 text-base font-semibold text-zinc-50">{title}</h3>
        {children}
      </div>
    </div>
  );
}
