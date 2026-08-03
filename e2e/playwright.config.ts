import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * E2E suite for the Waypoint web app.
 *
 * The app is expected to already be running (`make run`) — the suite does not
 * boot it, so it can also be pointed at a deployed instance via E2E_BASE_URL.
 *
 *   bun run e2e
 */
export default defineConfig({
  testDir: path.join(__dirname, "specs"),
  fullyParallel: false,
  workers: 1, // the specs mutate shared fixture rows in dev.db
  retries: 0,
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], channel: undefined } }],
});
