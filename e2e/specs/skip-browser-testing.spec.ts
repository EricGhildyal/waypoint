import { expect, type Page, test } from "@playwright/test";
import { CREATED_TASK_PREFIX, FIXTURES, SKIP_TESTING_TOKENS } from "../fixtures/ids";
import { reseed } from "../fixtures/reseed";

/**
 * "Skip browser testing" — a per-task opt-out of the browser (Playwright)
 * testing stage, for changes with no UI. The project's test suite and coverage
 * gate still run.
 *
 * The contract this suite pins down:
 *   - the New Task form carries the checkbox, off by default, label-associated
 *     and keyboard operable
 *   - checking it hides the (now unused) Testing model select; unchecking it
 *     brings the select back, and the other three stages are never touched
 *   - the flag reaches the create-task API and the task detail page says so
 *   - a task created with the box clear behaves exactly as before
 *   - the runner's skip branch, replayed over the sync endpoint, drives the
 *     task to Opening PR on a green suite and back to Implementing on a red one
 */

const HINT =
  "For changes with no UI. Skips the browser (Playwright) testing stage — " +
  "the project's test suite and coverage gate still run.";

const checkbox = (page: Page) => page.locator("#skip-testing");
const modelSelect = (page: Page, stage: string) => page.locator(`select[name="models.${stage}"]`);

/** The runner sync endpoint + Bearer header for one of the skipTesting fixtures. */
const sync = (id: keyof typeof SKIP_TESTING_TOKENS) => ({
  url: `/api/runner/tasks/${id}/sync`,
  headers: { authorization: `Bearer ${SKIP_TESTING_TOKENS[id]}` },
});

/** Fill the New Task form's required fields, leaving the checkbox alone. */
async function fillRequired(page: Page, title: string): Promise<void> {
  await page.locator('input[name="title"]').fill(title);
  await page.locator('textarea[name="prompt"]').fill("Fixture prompt from the e2e suite.");
}

test.beforeEach(() => {
  reseed();
});

test.describe("New Task form — Skip browser testing", () => {
  test("renders unchecked, with the hint explaining the test suite still runs", async ({
    page,
  }) => {
    await page.goto("/tasks/new");

    const box = checkbox(page);
    await expect(box).toBeVisible();
    await expect(box).toHaveAttribute("type", "checkbox");
    await expect(box).not.toBeChecked();

    const row = page.locator('label[for="skip-testing"]');
    await expect(row).toContainText("Skip browser testing");
    await expect(row).toContainText(HINT);
  });

  test("the label toggles the box, and so does the keyboard", async ({ page }) => {
    await page.goto("/tasks/new");
    const box = checkbox(page);

    // clicking the label text (not the 16px box) must toggle it
    await page.getByText("Skip browser testing", { exact: true }).click();
    await expect(box).toBeChecked();

    await box.focus();
    await page.keyboard.press("Space");
    await expect(box).not.toBeChecked();
  });

  test("checking it hides the Testing model select and unchecking restores it", async ({
    page,
  }) => {
    await page.goto("/tasks/new");
    await page.getByRole("button", { name: /Models/ }).click();

    for (const stage of ["planning", "implementation", "review", "testing"]) {
      await expect(modelSelect(page, stage)).toBeVisible();
    }

    await checkbox(page).check();
    await expect(modelSelect(page, "testing")).toHaveCount(0);
    // the stages that still run keep their pickers
    for (const stage of ["planning", "implementation", "review"]) {
      await expect(modelSelect(page, stage)).toBeVisible();
    }

    await checkbox(page).uncheck();
    await expect(modelSelect(page, "testing")).toBeVisible();
  });

  test("survives a re-render of the rest of the form", async ({ page }) => {
    await page.goto("/tasks/new");
    await checkbox(page).check();

    await page.getByRole("button", { name: "Hard", exact: true }).click();
    await page.locator('select[name="schedule"]').selectOption("later");

    await expect(checkbox(page)).toBeChecked();
  });
});

test.describe("New Task form — narrow viewport", () => {
  test.use({ viewport: { width: 375, height: 720 } });

  test("the checkbox row does not overflow at 375px", async ({ page }) => {
    await page.goto("/tasks/new");
    await expect(checkbox(page)).toBeVisible();

    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      375,
    );
    const row = page.locator('label[for="skip-testing"]');
    expect(await row.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(false);
  });
});

test.describe("Creating a task", () => {
  test("with the box checked, the flag is posted and the detail page says so", async ({ page }) => {
    await page.goto("/tasks/new");
    await fillRequired(page, `${CREATED_TASK_PREFIX} — skipping`);
    await checkbox(page).check();

    const posted = page.waitForRequest(
      (r) => r.method() === "POST" && new URL(r.url()).pathname === "/api/tasks",
    );
    await page.getByRole("button", { name: "Create task" }).click();
    expect(JSON.parse((await posted).postData() ?? "{}").skipTesting).toBe(true);

    // …and the task it created is marked on its detail page
    await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      `${CREATED_TASK_PREFIX} — skipping`,
    );
    await expect(page.locator("main p").first()).toContainText("browser testing skipped");
  });

  test("with the box clear, nothing changes", async ({ page }) => {
    await page.goto("/tasks/new");
    await fillRequired(page, `${CREATED_TASK_PREFIX} — not skipping`);

    const posted = page.waitForRequest(
      (r) => r.method() === "POST" && new URL(r.url()).pathname === "/api/tasks",
    );
    await page.getByRole("button", { name: "Create task" }).click();
    const body = JSON.parse((await posted).postData() ?? "{}");
    expect(body.skipTesting).toBe(false);
    // the Testing model is still chosen server-side, it is simply unused
    expect(body.models.testing).toBeTruthy();

    await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/);
    await expect(page.locator("main p").first()).not.toContainText("browser testing skipped");
  });
});

/**
 * The runner's skip branch is the same stage-start/stage-end sandwich the
 * browser-testing path sends, minus the agent: no session id, zero tokens, and
 * a synthetic test-findings artifact. Replaying it verifies the half of the
 * feature that lives in the app — stage row, findings panel and transition.
 */
test.describe("Testing stage — skip branch", () => {
  test("a green suite pushes the branch and hands off to Opening PR", async ({ page, request }) => {
    const id = FIXTURES.skipTestingTaskId;
    const { url, headers } = sync(id);

    await request.post(url, {
      headers,
      data: {
        cursor: null,
        stage: { action: "start", stage: "TESTING", attempt: 1, model: "claude-fable-5" },
        events: [
          {
            type: "LOG",
            stageRunId: "TESTING:1",
            payload: {
              level: "info",
              line: "browser testing skipped for this task — running test suite, then pushing",
            },
          },
        ],
      },
    });
    await request.post(url, {
      headers,
      data: {
        cursor: null,
        stage: {
          action: "end",
          stage: "TESTING",
          attempt: 1,
          status: "SUCCEEDED",
          artifacts: [
            { name: "pr.md", content: "Automated change by Waypoint." },
            {
              name: "test-findings-1.json",
              content: JSON.stringify({ verdict: "approve", findings: [] }),
            },
          ],
        },
      },
    });

    await page.goto(`/tasks/${id}`);
    await expect(page.locator("main p").first()).toContainText("browser testing skipped");

    // the Testing row exists but cost nothing — no browser agent ran
    const row = page.getByRole("button", { name: /^Testing #1/ });
    await expect(row).toBeVisible();
    await expect(row).toContainText("0");
    await expect(page.getByText("Testing cycle 1")).toBeVisible();
    await expect(page.getByText("No findings.")).toBeVisible();

    // …and the pipeline moved on exactly as it does after real browser testing
    await expect(page.getByText("Opening PR", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Testing → Opening PR (branch pushed)")).toBeVisible();
    await expect(page.getByText("Automated change by Waypoint.")).toBeVisible();
  });

  test("a red suite bounces back to Implementing with the failure as a finding", async ({
    page,
    request,
  }) => {
    const id = FIXTURES.skipTestingRedTaskId;
    const { url, headers } = sync(id);
    const description = "The test command (`bun test`) failed with exit code 1.";

    await request.post(url, {
      headers,
      data: {
        cursor: null,
        stage: { action: "start", stage: "TESTING", attempt: 1, model: "claude-fable-5" },
      },
    });
    await request.post(url, {
      headers,
      data: {
        cursor: null,
        stage: {
          action: "end",
          stage: "TESTING",
          attempt: 1,
          status: "SUCCEEDED",
          artifacts: [
            {
              name: "test-findings-1.json",
              content: JSON.stringify({
                verdict: "request_changes",
                findings: [{ severity: "high", category: "bug", file: "(tests)", description }],
              }),
            },
          ],
        },
      },
    });

    await page.goto(`/tasks/${id}`);
    await expect(page.getByText("Implementing", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Changes requested")).toBeVisible();
    await expect(page.getByText(description)).toBeVisible();
    await expect(page.getByText("(tests)")).toBeVisible();
    // the bounce counts against the testing cycle cap, same as a browser bounce
    await expect(page.getByText("Testing cycles used: 1/2")).toBeVisible();
  });
});
