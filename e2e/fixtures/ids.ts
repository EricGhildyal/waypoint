/** Fixed ids for the e2e fixtures, so specs can navigate straight to a task. */
export const FIXTURES = {
  projectName: "e2e-fixtures",
  /** IMPLEMENTING — Activity tab renders the Steer form. */
  steerTaskId: "e2e00000-0000-4000-8000-000000000001",
  /** NEEDS_INPUT + free-text question — Questions tab renders the Send form. */
  questionTaskId: "e2e00000-0000-4000-8000-000000000002",
  /** AWAITING_PLAN_APPROVAL — Plan tab renders Approve plan / Request changes. */
  planTaskId: "e2e00000-0000-4000-8000-000000000003",
  /** NEEDS_INPUT + multiple-choice question — segmented options above the Send form. */
  optionsTaskId: "e2e00000-0000-4000-8000-000000000004",
} as const;
