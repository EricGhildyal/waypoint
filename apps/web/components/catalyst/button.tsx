"use client";

import clsx from "clsx";
import type { ButtonHTMLAttributes } from "react";
import { Spinner } from "./spinner";

const buttonStyles = {
  solid: "bg-zinc-100 text-zinc-900 hover:bg-white disabled:bg-zinc-500 border border-transparent",
  primary:
    "bg-indigo-500 text-white hover:bg-indigo-400 disabled:bg-indigo-800 border border-transparent",
  outline:
    "bg-transparent text-zinc-200 border border-zinc-700 hover:border-zinc-500 hover:bg-zinc-900",
  danger: "bg-red-600/90 text-white hover:bg-red-500 disabled:bg-red-900 border border-transparent",
  ghost: "bg-transparent text-zinc-300 hover:bg-zinc-800 border border-transparent",
};

export function Button({
  variant = "solid",
  small = false,
  loading = false,
  className,
  children,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof buttonStyles;
  small?: boolean;
  /** Swap the label for a spinner without letting the button change size. */
  loading?: boolean;
}) {
  return (
    <button
      {...props}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={clsx(
        "relative inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-60",
        small ? "px-3 py-1.5 text-xs" : "px-4 py-2 text-sm",
        buttonStyles[variant],
        className,
      )}
    >
      {loading ? (
        <>
          <Spinner className={clsx("absolute", small && "size-3.5")} />
          {/* keeps the button its resting width so nothing jumps mid-request */}
          <span className="invisible">{children}</span>
        </>
      ) : (
        children
      )}
    </button>
  );
}
