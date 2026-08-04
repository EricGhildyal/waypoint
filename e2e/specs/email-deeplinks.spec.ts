import { expect, test } from "@playwright/test";
import { FIXTURES } from "../fixtures/ids";
import { reseed } from "../fixtures/reseed";

/**
 * Where the emails land. Every Waypoint notification carries one CTA pointing
 * at `/tasks/{id}?focus=plan` (plan approvals) or `/tasks/{id}?focus=question-{id}`
 * (everything else), and the recipient is expected to act right there — so the
 * deeplink must open the task with the right control already on screen, and
 * that control must complete the loop.
 *
 * `email-threading.spec.ts` pins down the hrefs these tests exercise.
 */

test.beforeEach(() => {
  reseed();
});

test.describe("email deeplinks", () => {
  test("?focus=plan opens the plan and its approve/request-changes controls", async ({ page }) => {
    await page.goto(`/tasks/${FIXTURES.planTaskId}?focus=plan`);

    await expect(page.getByRole("heading", { name: "Plan approval required" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve plan" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Request changes" })).toBeVisible();
    // the plan itself, rendered from plan.md
    await expect(page.getByRole("heading", { name: "Fixture plan" })).toBeVisible();
  });

  test("approving from the deeplink moves the task on", async ({ page }) => {
    await page.goto(`/tasks/${FIXTURES.planTaskId}?focus=plan`);
    await page.getByRole("button", { name: "Approve plan" }).click();

    await expect(page.getByRole("button", { name: "Approve plan" })).toBeHidden();
    await expect(page.locator("main")).toContainText("Implementing");
    await expect(page.locator("main")).toContainText("Plan approval → Implementing");
  });

  test("?focus=question-{id} opens the answer form, and answering closes it", async ({ page }) => {
    // the question id is generated per seed, so read it off the page first
    await page.goto(`/tasks/${FIXTURES.questionTaskId}`);
    const answer = page.getByRole("textbox", { name: "Answer…" });
    await expect(answer).toBeVisible();

    await page.goto(`/tasks/${FIXTURES.questionTaskId}?focus=questions`);
    await expect(page.locator("main")).toContainText(
      "Which cache backend should the session store use?",
    );
    await expect(page.locator("main")).toContainText("Question · open");

    await answer.fill("Use Redis.");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.locator("main")).toContainText("Question · answered");
    await expect(page.locator("main")).toContainText("Answered via ui:");
    await expect(page.locator("main")).toContainText("Use Redis.");
  });

  test("a deeplink to an unknown task 404s instead of erroring", async ({ page }) => {
    const res = await page.goto("/tasks/e2e00000-0000-4000-8000-00000000dead");
    expect(res?.status()).toBe(404);
  });
});
