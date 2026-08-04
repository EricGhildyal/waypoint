import { execFileSync } from "node:child_process";
import path from "node:path";
import { REPORT_BEGIN, REPORT_END } from "./email-ids";

const ROOT = path.resolve(__dirname, "../..");

export interface CapturedEmail {
  step: string;
  to: string[];
  from: string;
  subject: string;
  html: string;
  replyTo?: string;
  headers: Record<string, string>;
}

export interface EmailReport {
  emails: CapturedEmail[];
  /** Task.emailMessageId per fixture task id, as left in the DB. */
  tasks: Record<string, string | null>;
  /** Question.emailMessageId, keyed `{taskId}#{n}-{kind}`. */
  questions: Record<string, string | null>;
}

/**
 * Run the orchestrator's real email dispatcher against a fake Resend API in a
 * subprocess (same reasoning as `reseed.ts`: the Prisma client and the repo env
 * stay out of the Playwright worker) and return every captured message.
 */
export function runEmailDispatch(): EmailReport {
  const out = execFileSync("bunx", ["tsx", path.join(ROOT, "e2e/fixtures/email-dispatch.ts")], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      DATABASE_URL:
        process.env.DATABASE_URL ?? `file:${path.join(ROOT, "packages/core/prisma/dev.db")}`,
      TASK_DATA_DIR: process.env.TASK_DATA_DIR ?? path.join(ROOT, ".local/tasks"),
    },
  });
  const json = out
    .slice(out.indexOf(REPORT_BEGIN) + REPORT_BEGIN.length, out.indexOf(REPORT_END))
    .trim();
  if (!json) throw new Error(`email-dispatch produced no report:\n${out}`);
  return JSON.parse(json) as EmailReport;
}
