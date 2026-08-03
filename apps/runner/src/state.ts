import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Finding, Findings, StageName, UsageTotals } from "./types";

export type Phase =
  | "SETUP"
  | "PLANNING"
  | "AWAIT_PLAN"
  | "IMPLEMENTING"
  | "REVIEW"
  | "AWAIT_FINDINGS"
  | "TESTING"
  | "PUSH"
  | "AWAIT_STOP";

/**
 * Durable runner state on the workspace volume. Containers can be stopped,
 * restarted or recreated at any point (§5 pause/heartbeat/reconciliation) —
 * on boot the runner reads this file and continues exactly where it was,
 * resuming Agent SDK sessions by id.
 */
export interface RunnerState {
  phase: Phase;
  setupDone: boolean;
  /** attempt counters per stage (StageRun.attempt) */
  attempts: Partial<Record<StageName, number>>;
  /** Agent SDK session ids per stage (resume across restarts + fix-up rounds) */
  sessions: Partial<Record<StageName, string>>;
  /** last inbox item id received (sync cursor) */
  inboxCursor: string | null;
  /** findings driving the current implementation fix round */
  pendingFindings: { source: "review" | "testing"; findings: Findings } | null;
  /** review findings sitting in the approval gate (survives container restarts) */
  pendingApproval: { auto: Finding[]; gated: Finding[] } | null;
  /** plan revision notes from a rejected PLAN_APPROVAL answer */
  planNotes: string | null;
  /** local bounce counters (server keeps its own; caps enforced runner-side) */
  reviewCycles: number;
  testingCycles: number;
  /** ids of inbox answers already consumed (dedupe across restarts) */
  consumedAnswers: string[];
  /** cumulative token usage per "STAGE:attempt" (survives container restarts) */
  usageByRun: Record<string, UsageTotals>;
}

const INITIAL: RunnerState = {
  phase: "SETUP",
  setupDone: false,
  attempts: {},
  sessions: {},
  inboxCursor: null,
  pendingFindings: null,
  pendingApproval: null,
  planNotes: null,
  reviewCycles: 0,
  testingCycles: 0,
  consumedAnswers: [],
  usageByRun: {},
};

export class StateStore {
  private state: RunnerState;
  private readonly file: string;

  constructor(workspace: string) {
    this.file = path.join(workspace, ".waypoint", "state.json");
    this.state = this.load();
  }

  private load(): RunnerState {
    try {
      return { ...INITIAL, ...(JSON.parse(readFileSync(this.file, "utf8")) as RunnerState) };
    } catch {
      return { ...INITIAL };
    }
  }

  get(): RunnerState {
    return this.state;
  }

  update(patch: Partial<RunnerState>): RunnerState {
    this.state = { ...this.state, ...patch };
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.state, null, 2));
    return this.state;
  }

  nextAttempt(stage: StageName): number {
    const attempt = (this.state.attempts[stage] ?? 0) + 1;
    this.update({ attempts: { ...this.state.attempts, [stage]: attempt } });
    return attempt;
  }

  currentAttempt(stage: StageName): number {
    return this.state.attempts[stage] ?? 0;
  }

  setSession(stage: StageName, sessionId: string): void {
    this.update({ sessions: { ...this.state.sessions, [stage]: sessionId } });
  }
}
