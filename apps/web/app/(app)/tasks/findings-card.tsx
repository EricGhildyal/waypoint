"use client";

import clsx from "clsx";
import { Badge, Card, Subheading } from "@/components/catalyst";
import type { FindingsView, QuestionView } from "@/lib/task-detail";
import { FindingsApproval } from "./findings-approval";

// Caps mirror REVIEW_CYCLE_CAP / TESTING_CYCLE_CAP in @waypoint/core, which
// the client bundle can't import without dragging in Prisma.
const CYCLE_CAPS = { review: 3, test: 2 } as const;

/**
 * One review/test findings artifact, rendered inside its stage-run row.
 *
 * A review round that is (or was) gated on a FINDINGS_APPROVAL question renders
 * as this one card: the approval checkbox list replaces the read-only list
 * rather than sitting in a second box beside it. Nothing is lost — the
 * question's `items` are every finding in the artifact (gated ones numbered,
 * auto-fixed ones shown read-only under "Fixed automatically").
 */
export function FindingsCard({
  taskId,
  view,
  cyclesUsed,
  approval,
}: {
  taskId: string;
  view: FindingsView;
  cyclesUsed: number;
  /** The round's review gate, when it has one — this card becomes it. */
  approval?: QuestionView | null;
}) {
  const gate = approval?.items?.length ? approval : null;
  return (
    <Card className={clsx("space-y-2", gate?.status === "OPEN" && "border-amber-900/50")}>
      <div className="flex items-center gap-2">
        <Subheading>
          {view.kind === "review" ? "Review" : "Testing"} cycle {view.attempt}
        </Subheading>
        <Badge color={view.findings.verdict === "approve" ? "green" : "amber"}>
          {view.findings.verdict === "approve" ? "Approved" : "Changes requested"}
        </Badge>
      </div>
      {gate ? (
        <FindingsApproval taskId={taskId} question={gate} />
      ) : view.findings.findings.length === 0 ? (
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
