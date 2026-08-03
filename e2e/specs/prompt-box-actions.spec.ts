import { expect, test } from "@playwright/test";
import { FIXTURES } from "../fixtures/ids";
import { reseed } from "../fixtures/reseed";

/**
 * The three prompt boxes on the task detail page must have their action
 * buttons fill the width of the box:
 *   - Activity tab / Steer            -> single button, full width, below the textarea
 *   - Questions tab / Send            -> single button, full width, below the textarea
 *   - Plan tab / Approve · Request    -> two buttons side by side, half the width each
 * Each layout assertion is paired with the behaviour it must not break.
 */

/** Width of an element, rounded to whole CSS pixels. */
async function width(locator: import("@playwright/test").Locator): Promise<number> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("element is not visible");
  return Math.round(box.width);
}

async function top(locator: import("@playwright/test").Locator): Promise<number> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("element is not visible");
  return Math.round(box.y);
}

test.beforeEach(() => {
  reseed();
});

test.describe("Steer box (Activity tab)", () => {
  test("the Steer button fills the box width and sits below the textarea", async ({ page }) => {
    await page.goto(`/tasks/${FIXTURES.steerTaskId}`);

    const textarea = page.getByPlaceholder("Steer the agent mid-run");
    const steer = page.getByRole("button", { name: "Steer" });
    await expect(textarea).toBeVisible();
    await expect(steer).toBeVisible();

    expect(await width(steer)).toBe(await width(textarea));
    expect(await top(steer)).toBeGreaterThan(await top(textarea));
  });

  test("submitting empty still shows the validation error", async ({ page }) => {
    await page.goto(`/tasks/${FIXTURES.steerTaskId}`);

    await page.getByRole("button", { name: "Steer" }).click();
    await expect(page.getByText("Write a steering message first")).toBeVisible();
  });

  test("steering posts the message and clears the textarea", async ({ page }) => {
    await page.goto(`/tasks/${FIXTURES.steerTaskId}`);

    const textarea = page.getByPlaceholder("Steer the agent mid-run");
    await textarea.fill("Please prefer the smaller refactor");
    await page.getByRole("button", { name: "Steer" }).click();

    await expect(textarea).toHaveValue("");
    await expect(page.getByText("Please prefer the smaller refactor")).toBeVisible();
  });
});

test.describe("Answer box (Questions tab)", () => {
  test("the Send button fills the box width and sits below the textarea", async ({ page }) => {
    await page.goto(`/tasks/${FIXTURES.questionTaskId}?focus=questions`);

    const textarea = page.getByPlaceholder("Answer…");
    const send = page.getByRole("button", { name: "Send" });
    await expect(textarea).toBeVisible();

    expect(await width(send)).toBe(await width(textarea));
    expect(await top(send)).toBeGreaterThan(await top(textarea));
  });

  test("submitting empty still shows the validation error", async ({ page }) => {
    await page.goto(`/tasks/${FIXTURES.questionTaskId}?focus=questions`);

    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("Write an answer first")).toBeVisible();
  });

  test("answering records the answer and closes the question", async ({ page }) => {
    await page.goto(`/tasks/${FIXTURES.questionTaskId}?focus=questions`);

    await page.getByPlaceholder("Answer…").fill("Use the in-memory store for now.");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByText("Question · answered")).toBeVisible();
    await expect(page.getByText("Use the in-memory store for now.")).toBeVisible();
  });

  test("one-click options stay full width above the Send button and still answer", async ({
    page,
  }) => {
    await page.goto(`/tasks/${FIXTURES.optionsTaskId}?focus=questions`);

    const send = page.getByRole("button", { name: "Send" });
    const yes = page.getByRole("button", { name: "Yes", exact: true });
    const no = page.getByRole("button", { name: "No", exact: true });
    await expect(yes).toBeVisible();

    // the segmented group and the Send button below it span the same width
    expect((await width(yes)) + (await width(no))).toBeCloseTo(await width(send), -1);

    await yes.click();
    await expect(page.getByText("Answered via ui:")).toBeVisible();
    await expect(page.getByText("Question · answered")).toBeVisible();
  });
});

test.describe("Plan approval box (Plan tab)", () => {
  test("Approve plan and Request changes split the card width", async ({ page }) => {
    await page.goto(`/tasks/${FIXTURES.planTaskId}?focus=plan`);

    const textarea = page.getByPlaceholder("Revision notes");
    const approve = page.getByRole("button", { name: "Approve plan" });
    const request = page.getByRole("button", { name: "Request changes" });
    await expect(textarea).toBeVisible();

    const [approveW, requestW, textareaW] = [
      await width(approve),
      await width(request),
      await width(textarea),
    ];
    expect(approveW).toBe(requestW);
    // two halves plus the 8px gap fill the box
    expect(approveW + requestW + 8).toBe(textareaW);
    expect(await top(approve)).toBe(await top(request));
  });

  test("Request changes requires notes and sends the task back to planning", async ({ page }) => {
    await page.goto(`/tasks/${FIXTURES.planTaskId}?focus=plan`);

    await page.getByRole("button", { name: "Request changes" }).click();
    await expect(page.getByText("Describe the changes you want first")).toBeVisible();

    await page.getByPlaceholder("Revision notes").fill("Split step two into two smaller steps.");
    await page.getByRole("button", { name: "Request changes" }).click();

    await expect(page.getByText("Plan approval required")).toBeHidden();
    await expect(page.locator("h1").locator("..").getByText("Planning")).toBeVisible();
  });

  test("Approve plan moves the task to implementing", async ({ page }) => {
    await page.goto(`/tasks/${FIXTURES.planTaskId}?focus=plan`);

    await page.getByRole("button", { name: "Approve plan" }).click();

    await expect(page.getByText("Plan approval required")).toBeHidden();
    await expect(page.locator("h1").locator("..").getByText("Implementing")).toBeVisible();
  });
});

test.describe("narrow viewport", () => {
  test.use({ viewport: { width: 375, height: 720 } });

  test("nothing overflows at 375px", async ({ page }) => {
    await page.goto(`/tasks/${FIXTURES.planTaskId}?focus=plan`);
    await expect(page.getByRole("button", { name: "Approve plan" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      375,
    );

    await page.goto(`/tasks/${FIXTURES.steerTaskId}`);
    const textarea = page.getByPlaceholder("Steer the agent mid-run");
    await expect(textarea).toBeVisible();
    expect(await width(page.getByRole("button", { name: "Steer" }))).toBe(await width(textarea));
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      375,
    );
  });
});
