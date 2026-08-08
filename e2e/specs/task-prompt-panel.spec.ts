import { expect, type Locator, type Page, test } from "@playwright/test";
import { FIXTURES, PROMPT_FIXTURE_TEXT } from "../fixtures/ids";
import { reseed } from "../fixtures/reseed";

/**
 * The task detail page shows the task's prompt in a read-only <details>
 * disclosure sitting between the page header and the stage-run list.
 *
 * The contract this suite pins down:
 *   - present on every task in every status, collapsed on first paint
 *   - expands to the full prompt as PLAIN text (not markdown), line breaks kept
 *   - genuinely read-only on every status covered here: no input, textarea or
 *     contenteditable inside it. (A task that hasn't started yet — DRAFT,
 *     SCHEDULED or BLOCKED — additionally gets an Edit button that swaps in a
 *     textarea; there is no fixture in those statuses, so it isn't covered.)
 *   - stays expanded across the page's 2.5s SWR polling, and while the
 *     stage-run rows below it are expanded and collapsed
 *   - long prompts scroll inside the panel instead of pushing the list down
 *   - nothing overflows horizontally, including at 375px
 */

/**
 * The Prompt disclosure — the page's only <details>; the stage-run rows are
 * controlled Disclosure buttons rather than native disclosures.
 */
function promptPanel(page: Page): Locator {
  return page
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: "Prompt" }) })
    .first();
}

function promptSummary(page: Page): Locator {
  return promptPanel(page).locator("> summary");
}

/** The rendered prompt paragraph inside the expanded panel. */
function promptBody(page: Page): Locator {
  return promptPanel(page).locator("> div p");
}

async function isOpen(page: Page): Promise<boolean> {
  return await promptPanel(page).evaluate((d: HTMLDetailsElement) => d.open);
}

test.beforeEach(() => {
  reseed();
});

test.describe("Prompt panel", () => {
  test("is collapsed on first paint and sits between the header and the stage-run list", async ({
    page,
  }) => {
    await page.goto(`/tasks/${FIXTURES.steerTaskId}`);

    const panel = promptPanel(page);
    await expect(panel).toBeVisible();
    expect(await isOpen(page)).toBe(false);
    await expect(promptBody(page)).toBeHidden();

    // the header block is the disclosure's immediate predecessor…
    const prev = await panel.evaluate((d) => d.previousElementSibling?.textContent ?? "");
    expect(prev).toContain("E2E — steer form");

    // …and the stage-run list sits wholly below it
    const firstRow = page.getByRole("button", { name: /^Implementation #1/ });
    await expect(firstRow).toBeVisible();
    const [panelBox, rowBox] = [await panel.boundingBox(), await firstRow.boundingBox()];
    expect(panelBox && rowBox).toBeTruthy();
    expect(panelBox!.y + panelBox!.height).toBeLessThanOrEqual(rowBox!.y);
  });

  test("expanding reveals the prompt, collapsing hides it again", async ({ page }) => {
    await page.goto(`/tasks/${FIXTURES.steerTaskId}`);

    await promptSummary(page).click();
    await expect(promptBody(page)).toHaveText(
      "Fixture task parked in IMPLEMENTING so the steer box renders.",
    );

    await promptSummary(page).click();
    await expect(promptBody(page)).toBeHidden();
  });

  test("is keyboard operable", async ({ page }) => {
    await page.goto(`/tasks/${FIXTURES.steerTaskId}`);

    await promptSummary(page).focus();
    await page.keyboard.press("Enter");
    await expect(promptBody(page)).toBeVisible();
  });

  test("is read-only — no editable control anywhere inside it", async ({ page }) => {
    await page.goto(`/tasks/${FIXTURES.steerTaskId}`);
    await promptSummary(page).click();
    await expect(promptBody(page)).toBeVisible();

    const panel = promptPanel(page);
    await expect(panel.locator("input, textarea, select, [contenteditable]")).toHaveCount(0);
    await expect(panel.locator("button")).toHaveCount(0);
    // the text itself is selectable so it can be copied
    await expect(promptBody(page)).toHaveCSS("user-select", "auto");
  });

  test("renders the prompt as plain text, preserving line breaks and not parsing markdown", async ({
    page,
  }) => {
    await page.goto(`/tasks/${FIXTURES.promptTaskId}`);
    await promptSummary(page).click();

    const body = promptBody(page);
    await expect(body).toBeVisible();

    // exact text, including the literal '#', '-' and '**' markdown characters
    expect(await body.textContent()).toBe(PROMPT_FIXTURE_TEXT);

    // no markdown was turned into elements — it is a single text node
    expect(await body.evaluate((el) => el.childElementCount)).toBe(0);
    await expect(body).toHaveCSS("white-space", "pre-wrap");
  });

  test("wraps a long unbroken token instead of scrolling the page sideways", async ({ page }) => {
    await page.goto(`/tasks/${FIXTURES.promptTaskId}`);
    await promptSummary(page).click();

    const body = promptBody(page);
    await expect(body).toBeVisible();
    await expect(body).toHaveCSS("overflow-wrap", "break-word");

    const overflow = await body.evaluate((el) => ({
      x: el.scrollWidth > el.clientWidth,
      page: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    }));
    expect(overflow.x).toBe(false);
    expect(overflow.page).toBe(false);
  });

  test("caps a long prompt at a scrollable region rather than pushing the list down", async ({
    page,
  }) => {
    await page.goto(`/tasks/${FIXTURES.promptTaskId}`);
    await promptSummary(page).click();

    const body = promptBody(page);
    await expect(body).toBeVisible();

    const metrics = await body.evaluate((el) => ({
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      maxHeight: getComputedStyle(el).maxHeight,
      overflowY: getComputedStyle(el).overflowY,
    }));
    // max-h-80 == 320px, and the content genuinely exceeds it
    expect(metrics.maxHeight).toBe("320px");
    expect(metrics.clientHeight).toBeLessThanOrEqual(320);
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
    expect(metrics.overflowY).toBe("auto");

    // the stage-run list is still reachable near the top of the page
    const listTop = await page
      .getByRole("button", { name: /^Implementation #1/ })
      .evaluate((el) => el.getBoundingClientRect().top);
    expect(listTop).toBeLessThan(700);
  });

  test("stays expanded across the 2.5s polling re-renders", async ({ page }) => {
    await page.goto(`/tasks/${FIXTURES.steerTaskId}`);
    await promptSummary(page).click();
    await expect(promptBody(page)).toBeVisible();

    // count the SWR polls that land while the panel is open
    let polls = 0;
    page.on("response", (r) => {
      if (new URL(r.url()).pathname === `/api/tasks/${FIXTURES.steerTaskId}`) polls += 1;
    });

    await page.waitForTimeout(9000);

    expect(polls).toBeGreaterThanOrEqual(2);
    expect(await isOpen(page)).toBe(true);
    await expect(promptBody(page)).toBeVisible();
  });

  test("stays expanded, and above the list, while stage-run rows are toggled", async ({ page }) => {
    await page.goto(`/tasks/${FIXTURES.historyTaskId}`);
    await promptSummary(page).click();
    await expect(promptBody(page)).toBeVisible();

    // collapsing and re-expanding the rows below must not disturb the panel
    for (const row of [/^Planning #1/, /^Implementation #1/, /^Review #1/, /^Planning #1/]) {
      const header = page.getByRole("button", { name: row }).first();
      await header.click();

      expect(await isOpen(page), `panel collapsed after toggling ${row}`).toBe(true);
      await expect(promptBody(page)).toBeVisible();

      const [panelTop, rowTop] = [
        await promptPanel(page).evaluate((el) => el.getBoundingClientRect().top),
        await header.evaluate((el) => el.getBoundingClientRect().top),
      ];
      expect(panelTop, `panel dropped below the list after toggling ${row}`).toBeLessThan(rowTop);
    }
  });

  test("falls back to a placeholder when the prompt is blank", async ({ page }) => {
    await page.goto(`/tasks/${FIXTURES.blankPromptTaskId}`);
    await promptSummary(page).click();

    await expect(promptPanel(page).locator("> div")).toHaveText("No prompt recorded.");
  });

  test("appears on every task status", async ({ page }) => {
    const ids = [
      FIXTURES.steerTaskId, // IMPLEMENTING
      FIXTURES.questionTaskId, // NEEDS_INPUT
      FIXTURES.planTaskId, // AWAITING_PLAN_APPROVAL
      FIXTURES.optionsTaskId, // NEEDS_INPUT + options
      FIXTURES.blankPromptTaskId, // PAUSED
      FIXTURES.historyTaskId, // DONE
    ];

    for (const id of ids) {
      await page.goto(`/tasks/${id}`);
      await expect(promptPanel(page), `no Prompt panel on /tasks/${id}`).toBeVisible();
      expect(await isOpen(page), `panel started open on /tasks/${id}`).toBe(false);
    }
  });
});

test.describe("Prompt panel — narrow viewport", () => {
  test.use({ viewport: { width: 375, height: 720 } });

  test("nothing overflows at 375px, collapsed or expanded", async ({ page }) => {
    for (const id of [FIXTURES.steerTaskId, FIXTURES.promptTaskId]) {
      await page.goto(`/tasks/${id}`);
      await expect(promptPanel(page)).toBeVisible();

      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        375,
      );

      await promptSummary(page).click();
      await expect(promptBody(page)).toBeVisible();

      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        375,
      );
      expect(await promptBody(page).evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(false);
    }
  });

  test("survives the Activity | Checklist switch", async ({ page }) => {
    await page.goto(`/tasks/${FIXTURES.historyTaskId}`);
    await promptSummary(page).click();
    await expect(promptBody(page)).toBeVisible();

    // the panel sits above the switcher, so it belongs to both views
    for (const view of ["Checklist", "Activity"]) {
      await page.getByRole("button", { name: view, exact: true }).click();
      expect(await isOpen(page), `panel collapsed on the ${view} view`).toBe(true);
      await expect(promptBody(page)).toBeVisible();
    }
  });
});

test.describe("Prompt panel — FAILED task", () => {
  const PROMPT = "Fixture task parked in FAILED so the Retry dialog renders.";

  test("sits above the failure card and stays read-only beside the Retry textarea", async ({
    page,
  }) => {
    await page.goto(`/tasks/${FIXTURES.failedTaskId}`);

    const panel = promptPanel(page);
    await expect(panel).toBeVisible();
    expect(await isOpen(page)).toBe(false);

    // header, then the Prompt panel, then the failure card
    expect(await panel.evaluate((d) => d.nextElementSibling?.textContent ?? "")).toContain(
      "GIT_CLONE",
    );

    await promptSummary(page).click();
    await expect(promptBody(page)).toHaveText(PROMPT);

    // opening Retry gives the page an editable prompt textarea — but not inside the panel
    await page.getByRole("button", { name: "Retry" }).click();
    const retryBox = page.locator("textarea");
    await expect(retryBox).toHaveValue(PROMPT);
    await expect(panel.locator("textarea")).toHaveCount(0);
    expect(await isOpen(page)).toBe(true);
  });

  test("shows the revised prompt after a Retry edit", async ({ page }) => {
    await page.goto(`/tasks/${FIXTURES.failedTaskId}`);
    await promptSummary(page).click();
    await expect(promptBody(page)).toHaveText(PROMPT);

    await page.getByRole("button", { name: "Retry" }).click();
    await page.locator("textarea").fill("EDITED VIA RETRY\nsecond line stays on its own line.");
    await page.getByRole("button", { name: "Go", exact: true }).click();

    // the panel picks the new prompt up on the next poll, without collapsing
    await expect(promptBody(page)).toHaveText(
      "EDITED VIA RETRY\nsecond line stays on its own line.",
      { timeout: 15000 },
    );
    expect(await isOpen(page)).toBe(true);
  });
});
