"use client";

import { Badge, Card, Subheading } from "@/components/catalyst";
import type { FindingsView } from "@/lib/task-detail";

// Caps mirror REVIEW_CYCLE_CAP / TESTING_CYCLE_CAP in @waypoint/core, which
// the client bundle can't import without dragging in Prisma.
const CYCLE_CAPS = { review: 3, test: 2 } as const;

/** One review/test findings artifact, rendered inside its stage-run row. */
export function FindingsCard({ view, cyclesUsed }: { view: FindingsView; cyclesUsed: number }) {
  return (
    <Card className="space-y-2">
      <div className="flex items-center gap-2">
        <Subheading>
          {view.kind === "review" ? "Review" : "Testing"} cycle {view.attempt}
        </Subheading>
        <Badge color={view.findings.verdict === "approve" ? "green" : "amber"}>
          {view.findings.verdict === "approve" ? "Approved" : "Changes requested"}
        </Badge>
      </div>
      {view.findings.findings.length === 0 ? (
        <p className="text-sm text-zinc-500">No findings.</p>
      ) : (
        <ul className="space-y-2">
          {view.findings.findings.map((item) => (
            <li
              key={`${item.file}-${item.description}`}
              className="rounded-lg bg-zinc-900 p-2.5 text-sm"
            >
              <div className="flex items-center gap-2">
                {item.severity ? (
                  <Badge
                    color={
                      item.severity === "high"
                        ? "red"
                        : item.severity === "medium"
                          ? "amber"
                          : "zinc"
                    }
                  >
                    {item.severity}
                  </Badge>
                ) : null}
                <code className="text-xs text-zinc-400">{item.file}</code>
              </div>
              <p className="mt-1 text-zinc-300">{item.description}</p>
              {item.suggestion ? (
                <p className="mt-1 text-xs text-zinc-500">💡 {item.suggestion}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-zinc-500">
        {view.kind === "review" ? "Review" : "Testing"} cycles used: {cyclesUsed}/
        {CYCLE_CAPS[view.kind]}
      </p>
    </Card>
  );
}
