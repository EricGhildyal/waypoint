import { expect, test } from "@playwright/test";
import { FIXTURES, HISTORY_RUNS } from "../fixtures/ids";
import { reseed } from "../fixtures/reseed";

/**
 * The task page is a single scrollable GitHub-Actions-style list: one
 * collapsible row per stage run in chronological order, activity grouped
 * inside its row, findings in the Review row, a PR row at the end, and grayed
 * placeholders for stages that haven't started. The checklist rides a sticky
 * right rail on desktop and sits behind an Activity | Checklist switcher on
 * mobile.
 */

test.beforeEach(() => {
  reseed();
});

test.describe("stage-run list (history task)", () => {
  test("renders one row per run in chronological order, ending with the PR row", async ({
    page,
  }) => {
    await page.goto(`/tasks/${FIXTURES.historyTaskId}`);
    await expect(page.getByRole("button", { name: /^Planning #1/ })).toBeVisible();

    const texts = await page.locator("button[aria-expanded]").allTextContents();
    const rows = texts
      .map((t) => t.trim())
      .filter((t) => /^(Setup|Planning|Implementation|Review|Testing|Open PR)/.test(t));
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatch(/^Planning #1/);
    expect(rows[1]).toMatch(/^Implementation #1/);
    expect(rows[2]).toMatch(/^Review #1/);
    expect(rows[3]).toMatch(/^Open PR/);
  });

  test("a NULL-stageRunId event lands in the covering run's row and collapses with it", async ({
    page,
  }) => {
    await page.goto(`/tasks/${FIXTURES.historyTaskId}`);

    // the STATUS_CHANGE fixture event has no stageRunId; its timestamp falls
    // inside the implementation run's window
    await expect(page.getByText("Planning → Implementing")).toBeVisible();
    await page.getByRole("button", { name: /^Implementation #1/ }).click();
    await expect(page.getByText("Planning → Implementing")).toBeHidden();
  });

  test("answered questions render inline in their stage row", async ({ page }) => {
    await page.goto(`/tasks/${FIXTURES.historyTaskId}`);

    await expect(page.getByText("Keep the legacy settings export?")).toBeVisible();
    await expect(page.getByText("Answered via ui:")).toBeVisible();
    await expect(page.getByText("Drop it.")).toBeVisible();
  });

  test("review findings render inside the Review row", async ({ page }) => {
    await page.goto(`/tasks/${FIXTURES.historyTaskId}`);

    await expect(page.getByText("Review cycle 1")).toBeVisible();
    await expect(page.getByText("Approved", { exact: true })).toBeVisible();
    await expect(page.getByText("Fixture finding for the e2e suite.")).toBeVisible();
  });

  test("the PR row links the pull request and the approved plan collapses to View plan", async ({
    page,
  }) => {
    await page.goto(`/tasks/${FIXTURES.historyTaskId}`);

    await expect(
      page.getByRole("link", { name: "https://github.com/example/e2e-fixtures/pull/7 ↗" }),
    ).toBeVisible();

    const viewPlan = page.getByRole("button", { name: "View plan" });
    await expect(viewPlan).toHaveAttribute("aria-expanded", "false");
    await viewPlan.click();
    await expect(page.getByRole("heading", { name: "History plan" })).toBeVisible();
  });

  test("each run's row links its raw transcript", async ({ page }) => {
    await page.goto(`/tasks/${FIXTURES.historyTaskId}`);

    const links = page.getByRole("link", { name: "raw transcript ↗" });
    await expect(links).toHaveCount(3);
    await expect(links.first()).toHaveAttribute(
      "href",
      `/api/tasks/${FIXTURES.historyTaskId}/transcript/${HISTORY_RUNS.planning}`,
    );
  });
});

test.describe("review gate (findings task)", () => {
  // The gate and the findings artifact describe the same review round, so they
  // render as ONE card — the "Review cycle N" card IS the approval step. This
  // guards the regression where both were drawn and every finding appeared
  // twice on the page.
  test("the Review cycle card is the approval step, not a second box", async ({ page }) => {
    await page.goto(`/tasks/${FIXTURES.findingsTaskId}`);

    await expect(page.getByText("Review cycle 1")).toBeVisible();
    await expect(page.getByText("Changes requested")).toBeVisible();
    await expect(page.getByRole("checkbox")).toHaveCount(2);
    await expect(page.getByRole("button", { name: "Fix 2 findings" })).toBeVisible();
    await expect(page.getByText("Review cycles used: 1/3")).toBeVisible();

    // no separate "Review findings — N need your approval" box (the task title
    // also contains "review findings", so match the old heading exactly), and
    // no finding printed twice
    await expect(page.getByText(/Review findings\s+—/)).toHaveCount(0);
    const body = await page.locator("body").innerText();
    expect(body.split("Session cookie is written without the Secure flag.")).toHaveLength(2);
  });
});

test.describe("placeholders (running task)", () => {
  test("un-started pipeline stages show as disabled grayed rows", async ({ page }) => {
    await page.goto(`/tasks/${FIXTURES.steerTaskId}`);
    await expect(page.getByRole("button", { name: /^Implementation #1/ })).toBeVisible();

    for (const name of ["Review not started", "Testing not started", "Open PR not started"]) {
      await expect(page.getByRole("button", { name })).toBeDisabled();
    }
  });
});

test.describe("mobile", () => {
  test.use({ viewport: { width: 375, height: 720 } });

  test("the Activity | Checklist switcher swaps views and nothing overflows", async ({ page }) => {
    await page.goto(`/tasks/${FIXTURES.historyTaskId}`);
    await expect(page.getByRole("button", { name: /^Planning #1/ })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      375,
    );

    await page.getByRole("button", { name: "Checklist", exact: true }).click();
    await expect(page.getByText("Wire the settings form")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Planning #1/ })).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      375,
    );
  });
});
