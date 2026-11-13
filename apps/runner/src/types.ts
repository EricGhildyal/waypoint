/**
 * Runner-local copies of the wire types (§6). The runner deliberately does NOT
 * depend on @waypoint/core — its only channel to the host is POST /sync, and
 * its image stays free of Prisma/Next. Keep these in lock-step with
 * packages/core/src/schemas.ts.
 */

export type StageName = "PLANNING" | "IMPLEMENTATION" | "REVIEW" | "TESTING" | "PR_FEEDBACK";
export type StageRunStatus = "RUNNING" | "SUCCEEDED" | "FAILED" | "INTERRUPTED";

export interface ChecklistItem {
  text: string;
  state: "pending" | "in_progress" | "completed";
}

/** A checklist item plus the agent-tool id it came from (runner-local, never sent). */
export interface TrackedItem extends ChecklistItem {
  id: string;
}

export type FindingCategory =
  "readability" | "simplification" | "bug" | "edge_case" | "deviation" | "other";

export interface Finding {
  severity?: "high" | "medium" | "low";
  category: FindingCategory;
  file: string;
  description: string;
  suggestion?: string;
}

export interface Findings {
  verdict: "approve" | "request_changes";
  findings: Finding[];
}

/** One row of a FINDINGS_APPROVAL checkbox list; `number` is null for auto rows. */
export interface FindingApprovalItem {
  number: number | null;
  auto: boolean;
  severity?: "high" | "medium" | "low";
  category: FindingCategory;
  file: string;
  description: string;
  suggestion?: string;
}

export interface SyncEvent {
  type: "LOG" | "ERROR";
  payload: unknown;
  stageRunId?: string;
}

export interface SyncUsage {
  stageRunId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface SyncQuestion {
  kind: "QUESTION" | "PLAN_APPROVAL" | "FINDINGS_APPROVAL";
  text: string;
  contextSummary: string;
  options?: string[];
  items?: FindingApprovalItem[];
}

export type SyncStage =
  | { action: "start"; stage: StageName; attempt: number; model: string; sessionId?: string }
  | {
      action: "end";
      stage: StageName;
      attempt: number;
      status: StageRunStatus;
      sessionId?: string;
      artifacts?: Array<{ name: string; content: string }>;
    };

/**
 * One Claude plan limit window reading, from `SDKRateLimitInfo`. `type` is the
 * SDK's `rateLimitType` passed through verbatim as an open string — the host
 * decides which names it knows how to display, so a window name the SDK adds
 * later rides through instead of failing this runner's syncs.
 */
export interface UsageWindow {
  type: string;
  utilization: number;
  resetsAt?: string;
}

export interface SyncRequest {
  cursor: string | null;
  events?: SyncEvent[];
  usage?: SyncUsage;
  checklist?: ChecklistItem[];
  question?: SyncQuestion;
  stage?: SyncStage;
  rateLimit?: { resetsAt: string };
  /** SDK `allowed_warning` rate-limit event — display only, never pauses (§5). */
  rateLimitWarning?: { utilization?: number; resetsAt?: string };
  /** Latest reading per Claude limit window — display only (settings page bars). */
  usageWindows?: UsageWindow[];
}

export type InboxItem =
  | { id: string; type: "steering"; text: string }
  | {
      id: string;
      type: "answer";
      questionId: string;
      answer: string;
      /** sha256 of "{kind}\n{text}" of the question answered — see questionKey(). */
      key?: string;
    };

export interface SyncResponse {
  inbox: InboxItem[];
  control: "run" | "pause" | "stop";
  /**
   * Present (possibly empty) while the task is ADDRESSING_FEEDBACK: the user's
   * pull-request comments for the agent to address. Empty means there is
   * nothing to address and the branch only needs syncing with the default
   * branch. Re-sent on every sync, so it survives a container restart.
   */
  prFeedback?: string;
}

export type CoverageFormat =
  "COBERTURA_XML" | "LCOV" | "CLOVER_XML" | "JACOCO_XML" | "GO_COVERPROFILE";

/** One independently run and gated test suite (mirrors core's TestSuiteSchema). */
export interface TestSuite {
  name: string;
  command: string;
  /** Folder under the repository root the command and coverage check run in; "" = root. */
  workdir: string;
  /** False: the command must pass, changed-line coverage isn't checked. */
  coverageEnabled: boolean;
  coverageFormat: CoverageFormat;
  /** Relative to workdir. */
  coverageReportPath: string;
  coverageBar: number;
}

export interface TaskMeta {
  taskId: string;
  title: string;
  prompt: string;
  difficulty: "EASY" | "MEDIUM" | "HARD";
  branchName: string;
  verify: boolean;
  /** Skip the browser-testing agent; the test suite / coverage gate still runs. */
  skipTesting: boolean;
  /** Go from plan straight to implementation without asking (easy tasks). */
  autoApprovePlan?: boolean;
  models: { planning: string; implementation: string; review: string; testing: string };
  project: {
    name: string;
    repoUrl: string;
    defaultBranch: string;
    setupCommand: string;
    runCommand: string;
    runReadyUrl: string | null;
    migrateCommand: string | null;
    /** Empty: no test or coverage gate. */
    testSuites: TestSuite[];
    lintCommand: string | null;
    formatCommand: string | null;
    instructions: string;
  };
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** Cycle-cap option strings — must match packages/core constants verbatim. */
export const CYCLE_CAP_OPTION_CONTINUE = "Run another fix cycle";
export const CYCLE_CAP_OPTION_CANCEL = "Cancel the task";
export const REVIEW_CYCLE_CAP = 3;
export const TESTING_CYCLE_CAP = 2;

/** Findings the review agent may fix on its own authority — must match core. */
export const AUTO_FIX_CATEGORIES: FindingCategory[] = ["readability", "simplification"];

/** FINDINGS_APPROVAL answer codec — must match packages/core constants verbatim. */
export function parseFindingSelection(answer: string, count: number): number[] {
  if (/\bnone\b|\bskip\b|\bno(ne|thing)?\b/i.test(answer) && !/\d/.test(answer)) return [];
  if (/\ball\b/i.test(answer) && !/\d/.test(answer)) {
    return Array.from({ length: count }, (_, i) => i + 1);
  }
  const picked = new Set<number>();
  for (const match of answer.matchAll(/\d+/g)) {
    const n = Number(match[0]);
    if (n >= 1 && n <= count) picked.add(n);
  }
  return [...picked].toSorted((a, b) => a - b);
}

/**
 * Whether a PLAN_APPROVAL answer approves the plan. "Approved, but also add X"
 * is not an approval — it carries instructions, and treating it as one would
 * drop them — so only a short reply that starts with "approve" and has no
 * "but" counts. Anything else is revision notes. Must match packages/core constants verbatim.
 */
export function isPlanApproval(answer: string): boolean {
  const text = answer.trim();
  return /^approved?\b/i.test(text) && !/\bbut\b/i.test(text) && text.split(/\s+/).length <= 6;
}
