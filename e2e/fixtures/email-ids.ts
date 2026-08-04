/**
 * Fixed ids + payloads for the email-threading fixtures.
 *
 * These rows are created and torn down by `email-dispatch.ts`, which drives the
 * orchestrator's real dispatcher against a fake Resend API. They are separate
 * from `ids.ts` (the UI fixtures) because nothing in the browser renders them —
 * they exist purely to exercise outbound mail.
 */
/** stdout markers wrapping the driver's JSON report (this module stays
 *  dependency-free so the Playwright worker can import it without Prisma). */
export const REPORT_BEGIN = "---E2E-EMAIL-JSON-BEGIN---";
export const REPORT_END = "---E2E-EMAIL-JSON-END---";

export const EMAIL_FIXTURES = {
  projectName: "e2e-fixtures",
  /** Plan approval -> question -> findings -> done: four emails, one thread. */
  threadTaskId: "e2e00000-0000-4000-8000-0000000000e1",
  /** No questions ever: the DONE status email is the thread root. */
  statusRootTaskId: "e2e00000-0000-4000-8000-0000000000e2",
  /** Pre-migration task: Task.emailMessageId null, but a question was emailed. */
  legacyTaskId: "e2e00000-0000-4000-8000-0000000000e3",
  /** Open question AND a DONE event in the same dispatch tick. */
  sameTickTaskId: "e2e00000-0000-4000-8000-0000000000e4",
  /** Resend rejects this task's first send: no root may be persisted. */
  sendFailTaskId: "e2e00000-0000-4000-8000-0000000000e5",
  /** Plan text carrying raw HTML — markdownBlock() must not let it through. */
  planHtmlTaskId: "e2e00000-0000-4000-8000-0000000000e6",
} as const;

/** Titles double as the routing key for the fake Resend server. */
export const EMAIL_TITLES = {
  thread: "E2E — email thread",
  statusRoot: "E2E — email status root",
  legacy: "E2E — email legacy thread",
  sameTick: "E2E — email same tick",
  sendFail: "E2E — email send failure",
  planHtml: "E2E — email plan html",
} as const;

/** The Message-ID a pre-migration question email left behind. */
export const LEGACY_ROOT_MESSAGE_ID = "<q-legacy.00000000-0000-4000-8000-00000000abcd@e2e.test>";

/** Recipient used for the fake sends — must not be @waypoint.local (§8 recipients()). */
export const EMAIL_RECIPIENT = "e2e-email@example.invalid";

export const INBOUND_DOMAIN = "e2e.test";

/**
 * A realistic plan.md: a `# Title`, a first `## ` section with every markdown
 * construct the email must render, and a second `## ` section that the
 * first-section slice has to drop.
 */
export const PLAN_MARKDOWN = [
  "# Fixture plan",
  "",
  "## Overview",
  "",
  "The dispatcher **renders** this section, including `inline code` and a",
  "[deeplink](https://example.com/plan).",
  "",
  "- first bullet",
  "- second bullet",
  "",
  "## Checkbox task list",
  "",
  "- [ ] SECOND-SECTION-MARKER must never reach the email",
].join("\n");

/**
 * plan.md is agent-written, so it is untrusted input to the email renderer.
 * micromark must encode this rather than emit live HTML (allowDangerousHtml
 * stays off) — the email body is injected into the shell un-escaped.
 */
export const PLAN_WITH_RAW_HTML = [
  "## Overview",
  "",
  "<script>window.__waypointXss = true;</script>",
  "",
  '<img src="x" onerror="window.__waypointXss = true">',
  "",
  "Inline <b>bold tag</b> and a stray <div>block</div>.",
].join("\n");
