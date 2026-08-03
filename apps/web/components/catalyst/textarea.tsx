"use client";

import clsx from "clsx";
import type { TextareaHTMLAttributes } from "react";
import { fieldBase } from "./styles";

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={clsx(fieldBase, "min-h-20 leading-relaxed", className)} />;
}
