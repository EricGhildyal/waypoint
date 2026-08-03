"use client";

export function THead({ columns }: { columns: string[] }) {
  return (
    <thead className="border-b border-zinc-800 bg-zinc-900/70 text-xs uppercase tracking-wide text-zinc-500 sm:text-[0.8125rem]">
      <tr>
        {columns.map((c) => (
          <th key={c} className="px-4 py-3 font-medium sm:px-5">
            {c}
          </th>
        ))}
      </tr>
    </thead>
  );
}
