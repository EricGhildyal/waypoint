"use client";

import clsx from "clsx";
import type { InputHTMLAttributes } from "react";
import { fieldBase } from "./styles";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={clsx(fieldBase, className)} />;
}
