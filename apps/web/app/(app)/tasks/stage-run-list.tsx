"use client";

import { useEffect, useMemo, useState } from "react";
import { Card } from "@/components/catalyst";
import type { TaskDetail } from "@/lib/task-detail";
import {
  type FeedEvent,
  type Section,
  buildSections,
  resolveQuestionSection,
} from "./stage-run-groups";
import { SectionRow } from "./stage-run-row";

function sectionKey(section: Section): string {
  switch (section.kind) {
    case "run":
      return section.run.id;
    case "placeholder":
      return `placeholder-${section.stage}`;
    default:
      return section.kind;
  }
}

// Rows that have happened arrive expanded; Setup stragglers and grayed
// placeholders start collapsed. New runs appearing mid-poll have no override
// entry yet, so they also open by default.
function defaultOpen(section: Section): boolean {
  return section.kind === "run" || section.kind === "pr";
}

export function StageRunList({
  task,
  events,
  focus,
}: {
  task: TaskDetail;
  events: FeedEvent[];
  focus: string | null;
}) {
  const sections = useMemo(() => buildSections(task, events), [task, events]);

  // a ?focus=question-{id} deeplink expands the owning row even if the user
  // would otherwise find it collapsed
  const [overrides, setOverrides] = useState<Record<string, boolean>>(() => {
    if (focus?.startsWith("question-")) {
      const key = resolveQuestionSection(task, focus.slice("question-".length));
      if (key) return { [key]: true };
    }
    return {};
  });

  const now = useNow(task.stageRuns.some((r) => r.status === "RUNNING"));

  // plan.md always reflects the newest planning round — only that run shows it
  const planRunId = useMemo(() => {
    for (const s of sections.toReversed()) {
      if (s.kind === "run" && s.run.stage === "PLANNING") return s.run.id;
    }
    return null;
  }, [sections]);

  if (!sections.length) {
    return (
      <Card>
        <p className="text-sm text-zinc-500">No activity yet.</p>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {sections.map((section) => {
        const key = sectionKey(section);
        const open = overrides[key] ?? defaultOpen(section);
        return (
          <SectionRow
            key={key}
            task={task}
            section={section}
            open={open}
            onToggle={() => setOverrides((prev) => ({ ...prev, [key]: !open }))}
            focus={focus}
            now={now}
            showPlan={section.kind === "run" && section.run.id === planRunId}
          />
        );
      })}
    </div>
  );
}

/**
 * Client clock for the running row's elapsed time. Starts null so SSR and
 * hydration render identically, then ticks once mounted.
 */
function useNow(active: boolean): string | null {
  const [now, setNow] = useState<string | null>(null);
  useEffect(() => {
    if (!active) {
      setNow(null);
      return;
    }
    const tick = () => setNow(new Date().toISOString());
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
