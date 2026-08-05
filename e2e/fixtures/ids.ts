/** Fixed ids for the e2e fixtures, so specs can navigate straight to a task. */
export const FIXTURES = {
  projectName: "e2e-fixtures",
  /** IMPLEMENTING — the page renders the Steer form under the stage-run list. */
  steerTaskId: "e2e00000-0000-4000-8000-000000000001",
  /** NEEDS_INPUT + free-text question — the Send form renders inside its stage row. */
  questionTaskId: "e2e00000-0000-4000-8000-000000000002",
  /** AWAITING_PLAN_APPROVAL — the Planning row renders Approve plan / Request changes. */
  planTaskId: "e2e00000-0000-4000-8000-000000000003",
  /** NEEDS_INPUT + multiple-choice question — segmented options above the Send form. */
  optionsTaskId: "e2e00000-0000-4000-8000-000000000004",
  /** Multi-line markdown-ish prompt, long enough to exercise the Prompt panel's scroll cap. */
  promptTaskId: "e2e00000-0000-4000-8000-000000000005",
  /** Whitespace-only prompt — the Prompt panel's "No prompt recorded." branch. */
  blankPromptTaskId: "e2e00000-0000-4000-8000-000000000006",
  /** FAILED — the only status that also renders the (editable) Retry prompt textarea. */
  failedTaskId: "e2e00000-0000-4000-8000-000000000007",
  /** DONE with a full Planning→Impl→Review history, findings, and a PR. */
  historyTaskId: "e2e00000-0000-4000-8000-000000000008",
  /** skipTesting + TESTING — the skip branch's approve sync is replayed against it. */
  skipTestingTaskId: "e2e00000-0000-4000-8000-000000000009",
  /** skipTesting + TESTING — the skip branch's red-suite bounce is replayed against it. */
  skipTestingRedTaskId: "e2e00000-0000-4000-8000-00000000000a",
  /** NEEDS_INPUT on the review gate — the Review cycle card renders as the approval step. */
  findingsTaskId: "e2e00000-0000-4000-8000-00000000000b",
} as const;

/**
 * Runner tokens for the two skipTesting fixtures. The Testing stage's skip
 * branch talks to the app over the runner sync endpoint like any other stage,
 * so the specs replay its exact payloads with these as the Bearer token.
 */
export const SKIP_TESTING_TOKENS = {
  [FIXTURES.skipTestingTaskId]: "e2e-skip-token",
  [FIXTURES.skipTestingRedTaskId]: "e2e-skip-red-token",
} as const;

/**
 * Title prefix for tasks the specs create through the New Task form. The seed
 * deletes them, so re-runs start from a clean dashboard.
 */
export const CREATED_TASK_PREFIX = "E2E — created by spec";

/** Fixed StageRun ids for the history fixture, for transcript-link assertions. */
export const HISTORY_RUNS = {
  planning: "e2e00000-0000-4000-8000-0000000000a1",
  implementation: "e2e00000-0000-4000-8000-0000000000a2",
  review: "e2e00000-0000-4000-8000-0000000000a3",
} as const;

/**
 * The exact prompt seeded on `promptTaskId`. The Prompt panel must render this
 * verbatim: literal `#`/`-`/`**` (no markdown), blank lines preserved, and the
 * 200-character unbroken token wrapped rather than overflowing.
 */
export const PROMPT_FIXTURE_TEXT = [
  "# Heading that must stay literal",
  "",
  "Second paragraph after a blank line.",
  "- bullet one",
  "- bullet two",
  "",
  "**bold-ish** and `code-ish` must not render as markdown.",
  "",
  `LONG:${"x".repeat(200)}`,
  "",
  // padding so the body exceeds the max-h-80 (320px) cap and scrolls internally
  ...Array.from({ length: 40 }, (_, i) => `Padding line ${i + 1} to overflow the panel.`),
].join("\n");
