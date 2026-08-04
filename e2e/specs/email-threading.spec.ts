import { expect, test } from "@playwright/test";
import { EMAIL_FIXTURES, EMAIL_TITLES, LEGACY_ROOT_MESSAGE_ID } from "../fixtures/email-ids";
import { type CapturedEmail, type EmailReport, runEmailDispatch } from "../fixtures/email-run";

/**
 * Outbound mail (§8). Every email Waypoint sends about one task has to land in
 * a single Gmail conversation, which Gmail only does when BOTH hold:
 *
 *   - the subject matches, ignoring a leading "Re:"  -> `[Waypoint] {title}`
 *   - References/In-Reply-To point at a common root  -> Task.emailMessageId
 *
 * so the event-specific wording ("plan ready for approval", "done", …) lives in
 * a body label instead of the subject. Plan-approval emails additionally render
 * the plan's first section as real HTML rather than dumping raw markdown.
 *
 * The dispatcher is driven for real (see `fixtures/email-dispatch.ts`): the
 * orchestrator module is imported unchanged and its Resend client is pointed at
 * a local fake, so these assertions run against the exact bytes Gmail would get.
 * The rendered HTML is then loaded into the browser to check it as a document.
 */

let report: EmailReport;

test.beforeAll(() => {
  test.setTimeout(120_000);
  report = runEmailDispatch();
});

/** Emails for one fixture task, in send order. Other tasks in the dev DB may
 *  also get mail from the same dispatch — match on the title. */
function mailFor(title: string): CapturedEmail[] {
  return report.emails.filter((e) => e.subject.includes(title));
}

function baseSubject(email: CapturedEmail): string {
  return email.subject.replace(/^Re:\s*/, "");
}

/** The `<p>` under the `<h2>` title — the event label the subject no longer carries. */
function labelOf(email: CapturedEmail): string {
  return email.html.match(/<h2[^>]*>.*?<\/h2>\s*<p[^>]*>(.*?)<\/p>/s)?.[1]?.trim() ?? "";
}

test.describe("one Gmail thread per task", () => {
  test("plan, question, findings and done emails share one subject and one root", () => {
    const mail = mailFor(EMAIL_TITLES.thread);
    expect(mail.map((m) => m.step)).toEqual(["plan", "question", "findings", "done"]);

    // 1. subject: identical for all four, "Re:" on every follow-up
    for (const m of mail) {
      expect(baseSubject(m)).toBe(`[Waypoint] ${EMAIL_TITLES.thread}`);
    }
    expect(mail[0].subject.startsWith("Re:")).toBe(false);
    for (const m of mail.slice(1)) expect(m.subject.startsWith("Re: ")).toBe(true);

    // 2. headers: the first email is the root, the rest reference it
    const root = mail[0].headers["Message-ID"];
    expect(root).toMatch(/^<.+@e2e\.test>$/);
    expect(mail[0].headers["In-Reply-To"]).toBeUndefined();
    expect(mail[0].headers.References).toBeUndefined();
    for (const m of mail.slice(1)) {
      expect(m.headers["In-Reply-To"]).toBe(root);
      expect(m.headers.References).toBe(root);
      expect(m.headers["Message-ID"]).not.toBe(root); // fresh id per message
    }
    expect(new Set(mail.map((m) => m.headers["Message-ID"])).size).toBe(4);

    // 3. the root is persisted on the task, so later ticks keep the thread
    expect(report.tasks[EMAIL_FIXTURES.threadTaskId]).toBe(root);
  });

  test("the event wording moves into the body label, and nothing is lost", () => {
    const labels = mailFor(EMAIL_TITLES.thread).map(labelOf);
    expect(labels).toEqual([
      "Plan ready for approval",
      "Input needed",
      "1 review finding needs your approval",
      "Done",
    ]);
    // the old `[Waypoint] {title}: {event}` suffix is gone — a per-email
    // subject would silently break Gmail threading again
    for (const m of mailFor(EMAIL_TITLES.thread)) {
      expect(baseSubject(m)).not.toContain(":");
      expect(m.subject.toLowerCase()).not.toContain("plan ready");
      expect(m.subject.toLowerCase()).not.toContain("done");
    }
  });

  test("a task whose first email is a status notice starts the thread itself", () => {
    const mail = mailFor(EMAIL_TITLES.statusRoot);
    expect(mail).toHaveLength(1);
    expect(mail[0].subject).toBe(`[Waypoint] ${EMAIL_TITLES.statusRoot}`);
    expect(mail[0].headers["In-Reply-To"]).toBeUndefined();
    // status emails used to carry no Message-ID at all — they must now, or the
    // next email for the task has nothing to reference
    expect(mail[0].headers["Message-ID"]).toMatch(
      new RegExp(`^<task-${EMAIL_FIXTURES.statusRootTaskId}\\..+@e2e\\.test>$`),
    );
    expect(report.tasks[EMAIL_FIXTURES.statusRootTaskId]).toBe(mail[0].headers["Message-ID"]);
  });

  test("a task from before the migration adopts its last question email as the root", () => {
    const mail = mailFor(EMAIL_TITLES.legacy);
    expect(mail).toHaveLength(1);
    expect(mail[0].subject.startsWith("Re: ")).toBe(true);
    expect(mail[0].headers["In-Reply-To"]).toBe(LEGACY_ROOT_MESSAGE_ID);
    expect(mail[0].headers.References).toBe(LEGACY_ROOT_MESSAGE_ID);
    // adopted, not forked: the existing Gmail thread continues
    expect(report.tasks[EMAIL_FIXTURES.legacyTaskId]).toBe(LEGACY_ROOT_MESSAGE_ID);
  });

  test("two emails for one task in a single dispatch tick still thread", () => {
    const mail = mailFor(EMAIL_TITLES.sameTick);
    expect(mail).toHaveLength(2);
    expect(mail.every((m) => m.step === "same-tick")).toBe(true);
    // the second send must see the root the first one just wrote
    expect(mail[1].headers["In-Reply-To"]).toBe(mail[0].headers["Message-ID"]);
    expect(baseSubject(mail[1])).toBe(baseSubject(mail[0]));
  });

  test("a rejected send persists no root, so the next tick can retry cleanly", () => {
    expect(mailFor(EMAIL_TITLES.sendFail)).toHaveLength(0);
    expect(report.tasks[EMAIL_FIXTURES.sendFailTaskId]).toBeNull();
    const question = Object.entries(report.questions).find(([k]) =>
      k.startsWith(EMAIL_FIXTURES.sendFailTaskId),
    );
    expect(question?.[1]).toBeNull(); // sent-marker not set either
  });

  test("question emails keep their reply-to address and their own Message-ID", () => {
    const mail = mailFor(EMAIL_TITLES.thread);
    for (const m of mail.slice(0, 3)) {
      expect(m.replyTo).toMatch(/^q-[0-9a-f-]+@e2e\.test$/);
    }
    expect(mail[3].replyTo).toBeUndefined(); // status emails have no reply-to
    // the sent-marker column still mirrors each question email's Message-ID
    const stored = Object.entries(report.questions)
      .filter(([k]) => k.startsWith(EMAIL_FIXTURES.threadTaskId))
      .map(([, v]) => v);
    expect(stored).toEqual(mail.slice(0, 3).map((m) => m.headers["Message-ID"]));
  });
});

test.describe("plan approval email renders markdown", () => {
  test("the first plan section becomes real HTML in the browser", async ({ page }) => {
    const mail = mailFor(EMAIL_TITLES.thread)[0];
    await page.setContent(mail.html);

    const panel = page.locator("div[style*='background:#f4f4f5']");
    await expect(panel.locator("h1")).toHaveText("Fixture plan");
    await expect(panel.locator("h2")).toHaveText("Overview");
    await expect(panel.locator("li")).toHaveText(["first bullet", "second bullet"]);
    await expect(panel.locator("strong")).toHaveText("renders");
    await expect(panel.locator("code")).toHaveText("inline code");
    await expect(panel.locator("a")).toHaveAttribute("href", "https://example.com/plan");

    // no raw markdown syntax left anywhere in the body
    const text = (await panel.textContent()) ?? "";
    expect(text).not.toContain("## ");
    expect(text).not.toContain("**");
    expect(text).not.toContain("](");

    // and the panel is no longer a pre-wrap plain-text block
    const whiteSpace = await panel.evaluate((el) => getComputedStyle(el).whiteSpace);
    expect(whiteSpace).not.toBe("pre-wrap");
  });

  test("only the first section is included", async ({ page }) => {
    const mail = mailFor(EMAIL_TITLES.thread)[0];
    await page.setContent(mail.html);
    await expect(page.locator("body")).not.toContainText("SECOND-SECTION-MARKER");
    await expect(page.locator("body")).not.toContainText("Checkbox task list");
  });

  test("the CTA still deeplinks to the plan", async ({ page }) => {
    const mail = mailFor(EMAIL_TITLES.thread)[0];
    await page.setContent(mail.html);
    await expect(page.getByRole("link", { name: "Review plan" })).toHaveAttribute(
      "href",
      `http://localhost:3000/tasks/${EMAIL_FIXTURES.threadTaskId}?focus=plan`,
    );
  });

  test("HTML inside an agent-written plan is encoded, not executed", async ({ page }) => {
    const mail = mailFor(EMAIL_TITLES.planHtml)[0];
    expect(mail.html).toContain("&lt;script&gt;");
    expect(mail.html).not.toContain("<script>");

    await page.setContent(mail.html);
    expect(await page.locator("script").count()).toBe(0);
    expect(await page.locator("img").count()).toBe(0);
    expect(await page.evaluate(() => (window as { __waypointXss?: boolean }).__waypointXss)).toBe(
      undefined,
    );
    // the markup shows up as visible text instead
    await expect(page.locator("body")).toContainText("<script>");
    await expect(page.locator("body")).toContainText("<b>bold tag</b>");
  });

  test("non-plan emails stay plain-text panels", async ({ page }) => {
    const [, question, , done] = mailFor(EMAIL_TITLES.thread);
    for (const mail of [question, done]) {
      await page.setContent(mail.html);
      const panel = page.locator("div[style*='background:#f4f4f5']");
      const whiteSpace = await panel.evaluate((el) => getComputedStyle(el).whiteSpace);
      expect(whiteSpace).toBe("pre-wrap");
      expect(await panel.locator("h1, h2, ul, strong").count()).toBe(0);
    }
  });
});
