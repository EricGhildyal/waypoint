"use client";

import ReactMarkdown from "react-markdown";

export function Markdown({ children }: { children: string }) {
  return (
    <div className="prose-sm max-w-none space-y-3 text-sm leading-relaxed text-zinc-300 [&_a]:text-indigo-400 [&_code]:rounded [&_code]:bg-zinc-800 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-xs [&_h1]:text-lg [&_h1]:font-semibold [&_h1]:text-zinc-100 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-zinc-100 [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:text-zinc-100 [&_li]:ml-4 [&_ol]:list-decimal [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-zinc-900 [&_pre]:p-3 [&_ul]:list-disc">
      <ReactMarkdown>{children}</ReactMarkdown>
    </div>
  );
}
