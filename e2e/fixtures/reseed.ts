import { execFileSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");

/**
 * Reset the fixture rows before a spec runs. Spawned as a subprocess so the
 * Prisma client (and the repo's env) stay out of the Playwright worker.
 */
export function reseed(): void {
  execFileSync("bunx", ["tsx", path.join(ROOT, "e2e/fixtures/seed.ts")], {
    cwd: ROOT,
    stdio: "pipe",
    env: {
      ...process.env,
      DATABASE_URL:
        process.env.DATABASE_URL ?? `file:${path.join(ROOT, "packages/core/prisma/dev.db")}`,
      TASK_DATA_DIR: process.env.TASK_DATA_DIR ?? path.join(ROOT, ".local/tasks"),
    },
  });
}
