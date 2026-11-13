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

/**
 * Difficulty affects planning depth only (§7). These are the sections a plan
 * carries on top of the three every plan has (Overview, Steps, Relevant files
 * and context — fixed in planning.md because the harness parses them).
 */
const PLAN_DEPTH: Record<string, string> = {
  EASY: "- Test plan\n- Out of scope",
  MEDIUM: "- Risks\n- Edge cases\n- Test plan\n- Out of scope",
  HARD: "- Alternatives considered (and why this approach)\n- Risks\n- Edge cases\n- Migration / rollout notes\n- Test plan\n- Out of scope",
};

/**
 * Paragraphs shared by several stage prompts. They live here so each is stated
 * once: when asking the user is worth an email round-trip, what counts as a
 * reason to stop early, and who reads the files an agent writes for a human.
 */
const SHARED = {
  ASK_USER:
    "Nobody is watching this run. `ask_user` emails the user and blocks until they reply, which can take hours. Ask when the answer would change what you build and you cannot settle it from the repository, the task, or the plan: an ambiguous requirement, a scope or product decision, or a step that is destructive or hard to undo. For anything else, choose the reasonable option, state the assumption where the user will read it (the plan overview, `pr.md`, or your findings), and keep going.",
  FINISHING:
    "Finish the whole job before you stop. Errors, timeouts, flaky commands, and failing tools are ordinary obstacles: diagnose them and work through them (retry, fix the command, take another route). Stop early only when the work cannot move forward without the user, or when something was deliberately put out of bounds, such as the rules above or access that was withheld on purpose. In that case leave it alone and say plainly what you found.",
  WRITING:
    "The person reading this has not seen your tool calls or the files you opened, and is switching in from other work. Lead with what matters most to them, use full sentences and plain words, define any term you coined during the work, and leave out detail they do not need in order to act.",
};

/**
 * The test-gate bullets are computed here, not in the templates, because a
 * project without test suites has no gate and the prompts must not promise
 * one ({{placeholders}} have no conditional syntax).
 */
function testRules(project: RunnerConfig["meta"]["project"]): {
  IMPL_TEST_RULE: string;
  PLAN_TEST_NOTE: string;
} {
  const suites = project.testSuites;
  if (!suites.length) {
    return {
      IMPL_TEST_RULE:
        "This project has no automated test command, so the harness runs no test or coverage gate. Verify your changes work before you finish.",
      PLAN_TEST_NOTE:
        "This project has no test command and no coverage gate, so leave automated test work out of the plan unless the task asks for it.",
    };
  }
  const described = suites.map(describeSuite).join("; ");
  const anyCoverage = suites.some((s) => s.coverageEnabled);
  const coverageHow = anyCoverage
    ? ` Coverage is measured on the lines you changed (diff-cover against \`origin/${project.defaultBranch}\`).`
    : "";
  const many = suites.length > 1;
  return {
    IMPL_TEST_RULE: `Write tests alongside the code. After you finish, the harness runs ${many ? `each of the project's ${suites.length} test suites, and every one is enforced on its own` : "the project's test suite"}: ${described}.${coverageHow} Failures come back to you to fix, so run the tests yourself as you go.`,
    PLAN_TEST_NOTE: `The harness enforces ${many ? "these test suites separately" : "this test suite"} after implementation: ${described}.${coverageHow} Plan the test work as part of the steps${many ? ", in whichever suites the change touches" : ""}.`,
  };
}

/** One suite's requirement, on one line (the rules sit in markdown bullets). */
function describeSuite(suite: RunnerConfig["meta"]["project"]["testSuites"][number]): string {
  const where = suite.workdir ? `, run in \`${suite.workdir}\`` : "";
  const bar = suite.coverageEnabled
    ? `must pass with ${suite.coverageBar}% coverage of changed lines`
    : "must pass; coverage isn't measured";
  return `${suite.name} — \`${suite.command}\`${where}, ${bar}`;
}

/** Instruction files a repository may carry for coding agents, in reading order. */
const REPO_INSTRUCTION_FILES = ["CLAUDE.md", "AGENTS.md"];
const MAX_INSTRUCTION_CHARS = 20_000;

/**
 * What every stage is told about the project: the instructions entered in
 * Waypoint, then the repository's own agent instruction files. The files are
 * read here rather than through the SDK's project settings on purpose — that
 * route would also load the repository's hooks and permission rules into a
 * run the harness is supposed to control.
 */
function projectInstructions(config: RunnerConfig): string {
  const parts: string[] = [];
  const own = config.meta.project.instructions.trim();
  if (own) parts.push(own);

  const seen = new Set<string>();
  for (const file of REPO_INSTRUCTION_FILES) {
    let content: string;
    try {
      content = readFileSync(path.join(config.workspace, file), "utf8").trim();
    } catch {
      continue; // the repository has no such file
    }
    // AGENTS.md is often a copy of (or a symlink to) CLAUDE.md
    if (!content || seen.has(content)) continue;
    seen.add(content);
    const body =
      content.length > MAX_INSTRUCTION_CHARS
        ? `${content.slice(0, MAX_INSTRUCTION_CHARS)}\n\n(truncated — read \`${file}\` for the rest)`
        : content;
    parts.push(`From \`${file}\` in the repository:\n\n${body}`);
  }
  return parts.join("\n\n---\n\n") || "(none provided)";
}

export function renderPrompt(
  name: "planning" | "implementation" | "review" | "testing" | "merge" | "pr-feedback",
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
    PROJECT_INSTRUCTIONS: projectInstructions(config),
    DEFAULT_BRANCH: meta.project.defaultBranch,
    BRANCH_NAME: meta.branchName,
    SETUP_COMMAND: meta.project.setupCommand,
    RUN_COMMAND: meta.project.runCommand,
    RUN_READY_URL: meta.project.runReadyUrl ?? "(not configured)",
    ...SHARED,
    ...testRules(meta.project),
    ...extra,
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? "");
}
