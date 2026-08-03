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
  EASY: "- Goal\n- Ordered implementation steps (checkboxes)\n- Test plan\n- Out of scope",
  MEDIUM:
    "- Goal\n- Relevant files & context\n- Ordered implementation steps (checkboxes)\n- Risks\n- Edge cases\n- Test plan\n- Out of scope",
  HARD: "- Goal\n- Relevant files & context\n- Alternatives considered (and why this approach)\n- Ordered implementation steps (checkboxes)\n- Risks\n- Edge cases\n- Migration / rollout notes\n- Test plan\n- Explicit non-goals\n- Out of scope",
};

/**
 * The test-gate bullets are computed here, not in the templates, because a
 * project without a testCommand has no gate and the prompts must not promise
 * one ({{placeholders}} have no conditional syntax).
 */
function testRules(project: RunnerConfig["meta"]["project"]): {
  IMPL_TEST_RULE: string;
  PLAN_TEST_NOTE: string;
} {
  if (!project.testCommand) {
    return {
      IMPL_TEST_RULE:
        "**This project has no automated test command** — the harness will not run a test or coverage gate. Still verify your changes work before finishing.",
      PLAN_TEST_NOTE:
        "This project has no test command and no coverage gate — do not plan automated test work unless the task explicitly asks for it.",
    };
  }
  return {
    IMPL_TEST_RULE: `**Write tests alongside code.** The harness will run \`${project.testCommand}\` and enforce **${project.coverageBar}% changed-line coverage** (diff-cover vs \`origin/${project.defaultBranch}\`) after you finish — failures come back to you to fix, so run the tests yourself as you go.`,
    PLAN_TEST_NOTE: `Note that tests must reach ${project.coverageBar}% changed-line coverage (test command: \`${project.testCommand}\`) — plan the test work accordingly.`,
  };
}

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
    ...testRules(meta.project),
    ...extra,
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? "");
}
