import { z } from "zod";

// ---------------------------------------------------------------------------
// Event payload shapes (§3) — validated by emitEvent().
// ---------------------------------------------------------------------------

export const ChecklistItemSchema = z.object({
  text: z.string(),
  state: z.enum(["pending", "in_progress", "completed"]),
});
export type ChecklistItem = z.infer<typeof ChecklistItemSchema>;

export const EVENT_PAYLOAD_SCHEMAS = {
  STATUS_CHANGE: z.object({
    from: z.string(),
    to: z.string(),
    reason: z.string().optional(),
  }),
  TOKEN_UPDATE: z.object({
    stageRunId: z.string(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    cacheCreationTokens: z.number().int().nonnegative(),
  }),
  CHECKLIST_UPDATE: z.object({ items: z.array(ChecklistItemSchema) }),
  QUESTION: z.object({ questionId: z.string() }),
  ANSWER: z.object({ questionId: z.string(), via: z.enum(["UI", "EMAIL"]) }),
  STEER: z.object({ text: z.string() }),
  LOG: z.object({
    level: z.enum(["debug", "info", "warn", "error"]),
    line: z.string().max(500),
    // set on the model's own output so the UI can surface it in the highlights
    // feed: "assistant" = response text, "thinking" = extended thinking
    source: z.enum(["assistant", "thinking"]).optional(),
  }),
  ERROR: z.object({
    code: z.string(),
    message: z.string(),
    logTail: z.string().optional(),
  }),
  STAGE_START: z.object({
    stage: z.string(),
    attempt: z.number().int().positive(),
    model: z.string(),
  }),
  STAGE_END: z.object({
    stage: z.string(),
    attempt: z.number().int().positive(),
    status: z.string(),
  }),
  REVIEW_FINDINGS: z.object({
    attempt: z.number().int().positive(),
    verdict: z.enum(["approve", "request_changes"]),
    count: z.number().int().nonnegative(),
  }),
  TEST_FINDINGS: z.object({
    attempt: z.number().int().positive(),
    verdict: z.enum(["approve", "request_changes"]),
    count: z.number().int().nonnegative(),
  }),
  PR_OPENED: z.object({ url: z.string() }),
} as const;

export type EventTypeName = keyof typeof EVENT_PAYLOAD_SCHEMAS;

// ---------------------------------------------------------------------------
// Findings artifacts (§7) — review-findings.json / test-findings.json.
// ---------------------------------------------------------------------------

/**
 * Finding categories drive the review gate (§7): readability/simplification
 * findings cycle back to implementation on the agent's own authority, every
 * other category waits for a per-item yes/no from the user. Older artifacts
 * carry no category — they default to `other`, i.e. they need approval.
 */
export const FindingCategorySchema = z
  .enum(["readability", "simplification", "bug", "edge_case", "deviation", "other"])
  .default("other");
export type FindingCategory = z.infer<typeof FindingCategorySchema>;

export const FindingSchema = z.object({
  severity: z.enum(["high", "medium", "low"]).optional(),
  category: FindingCategorySchema,
  file: z.string(),
  description: z.string(),
  suggestion: z.string().optional(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const FindingsSchema = z.object({
  verdict: z.enum(["approve", "request_changes"]),
  findings: z.array(FindingSchema),
});
export type Findings = z.infer<typeof FindingsSchema>;

/**
 * One row of a FINDINGS_APPROVAL checkbox list. `number` is the 1-based
 * selection number the answer refers to; auto-fixed rows carry `null` and are
 * shown read-only (they are fixed whether or not anything else is approved).
 */
export const FindingApprovalItemSchema = z.object({
  number: z.number().int().positive().nullable(),
  auto: z.boolean(),
  severity: z.enum(["high", "medium", "low"]).optional(),
  category: FindingCategorySchema,
  file: z.string(),
  description: z.string(),
  suggestion: z.string().optional(),
});
export type FindingApprovalItem = z.infer<typeof FindingApprovalItemSchema>;

// ---------------------------------------------------------------------------
// Runner sync protocol (§6) — the runner's ONLY channel to the host.
// ---------------------------------------------------------------------------

const StageNameSchema = z.enum(["PLANNING", "IMPLEMENTATION", "REVIEW", "TESTING"]);
const StageRunStatusSchema = z.enum(["RUNNING", "SUCCEEDED", "FAILED", "INTERRUPTED"]);

export const SyncRequestSchema = z.object({
  cursor: z.string().nullable(), // id of last inbox item received
  events: z
    .array(
      z.object({
        type: z.enum(Object.keys(EVENT_PAYLOAD_SCHEMAS) as [EventTypeName, ...EventTypeName[]]),
        payload: z.unknown(),
        stageRunId: z.string().optional(),
      }),
    )
    .max(100)
    .optional(),
  usage: z
    .object({
      stageRunId: z.string(),
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      cacheReadTokens: z.number().int().nonnegative(),
      cacheCreationTokens: z.number().int().nonnegative(),
    })
    .optional(), // cumulative absolutes
  checklist: z.array(ChecklistItemSchema).optional(), // full snapshot
  question: z
    .object({
      kind: z.enum(["QUESTION", "PLAN_APPROVAL", "FINDINGS_APPROVAL"]),
      text: z.string(),
      contextSummary: z.string(),
      options: z.array(z.string()).optional(),
      items: z.array(FindingApprovalItemSchema).optional(), // FINDINGS_APPROVAL only
    })
    .optional(), // ≤1 open at a time
  stage: z
    .discriminatedUnion("action", [
      z.object({
        action: z.literal("start"),
        stage: StageNameSchema,
        attempt: z.number().int().positive(),
        model: z.string(),
        // session id becomes known just after start; the runner re-sends the
        // start (idempotent upsert) once the SDK init message arrives.
        sessionId: z.string().optional(),
      }),
      z.object({
        action: z.literal("end"),
        stage: StageNameSchema,
        attempt: z.number().int().positive(),
        status: StageRunStatusSchema,
        sessionId: z.string().optional(),
        artifacts: z.array(z.object({ name: z.string(), content: z.string() })).optional(), // plan.md, pr.md, findings JSONs
      }),
    ])
    .optional(),
  rateLimit: z.object({ resetsAt: z.string() }).optional(),
});
export type SyncRequest = z.infer<typeof SyncRequestSchema>;

export type InboxItem =
  | { id: string; type: "steering"; text: string }
  | { id: string; type: "answer"; questionId: string; answer: string };

export interface SyncResponse {
  inbox: InboxItem[];
  control: "run" | "pause" | "stop";
}

// ---------------------------------------------------------------------------
// Runner container config — serialized into the TASK_META env var.
// ---------------------------------------------------------------------------

export const TaskMetaSchema = z.object({
  taskId: z.string(),
  title: z.string(),
  prompt: z.string(),
  difficulty: z.enum(["EASY", "MEDIUM", "HARD"]),
  branchName: z.string(),
  verify: z.boolean(),
  // Skip the browser-testing agent in the Testing stage; the project's test
  // suite / coverage gate still runs. Default keeps pre-existing metas valid.
  skipTesting: z.boolean().default(false),
  models: z.object({
    planning: z.string(),
    implementation: z.string(),
    review: z.string(),
    testing: z.string(),
  }),
  project: z.object({
    name: z.string(),
    repoUrl: z.string(),
    defaultBranch: z.string(),
    setupCommand: z.string(),
    runCommand: z.string(),
    runReadyUrl: z.string().nullable(),
    migrateCommand: z.string().nullable(),
    testCommand: z.string().nullable(),
    coverageFormat: z.enum([
      "COBERTURA_XML",
      "LCOV",
      "CLOVER_XML",
      "JACOCO_XML",
      "GO_COVERPROFILE",
    ]),
    coverageReportPath: z.string(),
    lintCommand: z.string().nullable(),
    formatCommand: z.string().nullable(),
    instructions: z.string(),
    coverageBar: z.number().int(),
  }),
});
export type TaskMeta = z.infer<typeof TaskMetaSchema>;
