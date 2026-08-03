import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RunnerConfig } from "./config";

/**
 * Stage prompts are versioned files in apps/runner/prompts/*.md with
 * {{placeholders}} (§6) — editing agent behavior is a file edit + image
 * rebuild, not a code change.
 */
const PROMPT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts");

/** Difficulty affects planning depth only (§7). */
const PLAN_DEPTH: Record<string, string> = {
  EASY: "- Goal\n- Relevant files & context\n- Ordered implementation steps (checkboxes)\n- Test plan\n- Out of scope",
  MEDIUM:
    "- Goal\n- Relevant files & context\n- Ordered implementation steps (checkboxes)\n- Risks\n- Edge cases\n- Test plan\n- Out of scope",
  HARD: "- Goal\n- Relevant files & context\n- Alternatives considered (and why this approach)\n- Ordered implementation steps (checkboxes)\n- Risks\n- Edge cases\n- Migration / rollout notes\n- Test plan\n- Explicit non-goals\n- Out of scope",
};

export function renderPrompt(
  name: "planning" | "implementation" | "review" | "testing",
  config: RunnerConfig,
  extra: Record<string, string> = {},
): string {
  const template = readFileSync(path.join(PROMPT_DIR, `${name}.md`), "utf8");
  const { meta } = config;
  const vars: Record<string, string> = {
    TASK_TITLE: meta.title,
    TASK_PROMPT: meta.prompt,
    DIFFICULTY: meta.difficulty,
    PLAN_SECTIONS: PLAN_DEPTH[meta.difficulty] ?? PLAN_DEPTH.MEDIUM ?? "",
    PROJECT_NAME: meta.project.name,
    PROJECT_INSTRUCTIONS: meta.project.instructions || "(none provided)",
    DEFAULT_BRANCH: meta.project.defaultBranch,
    BRANCH_NAME: meta.branchName,
    SETUP_COMMAND: meta.project.setupCommand,
    RUN_COMMAND: meta.project.runCommand,
    RUN_READY_URL: meta.project.runReadyUrl ?? "(not configured)",
    TEST_COMMAND: meta.project.testCommand,
    COVERAGE_BAR: String(meta.project.coverageBar),
    ...extra,
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? "");
}
