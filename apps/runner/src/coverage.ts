import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import type { RunnerConfig } from "./config";
import { run, tail } from "./proc";
import type { TestSuite } from "./types";

export interface GateResult {
  ok: boolean;
  feedback: string;
}

/**
 * The test gate (§7): every test suite of the project is run and enforced on
 * its own — its command must pass and, when the suite requires coverage,
 * changed-line coverage ≥ its bar. All suites run even after one fails, so the
 * agent gets every failure in one round. Failures come back as agent feedback,
 * not verdicts. A project without suites has no gate — pass unconditionally.
 */
export async function runTestGate(config: RunnerConfig): Promise<GateResult> {
  const suites = config.meta.project.testSuites;
  const failures: string[] = [];
  for (const [index, suite] of suites.entries()) {
    const result = await runSuite(config, suite, index);
    if (!result.ok) {
      failures.push(
        suites.length > 1 ? `## Test suite "${suite.name}"\n\n${result.feedback}` : result.feedback,
      );
    }
  }
  return { ok: failures.length === 0, feedback: failures.join("\n\n") };
}

/** What the gate is about to do, for the log. */
export function testGateLabel(config: RunnerConfig): string {
  const suites = config.meta.project.testSuites;
  if (!suites.length) return "no test suites configured — skipping test gate";
  const parts = suites.map(
    (s) => `${s.name} (${s.coverageEnabled ? `tests + ${s.coverageBar}% coverage` : "tests"})`,
  );
  return `running test gate: ${parts.join(", ")}`;
}

export const suiteDir = (config: RunnerConfig, suite: TestSuite) =>
  path.join(config.workspace, suite.workdir);

const inDir = (suite: TestSuite) => (suite.workdir ? ` in \`${suite.workdir}\`` : "");

async function runSuite(
  config: RunnerConfig,
  suite: TestSuite,
  index: number,
): Promise<GateResult> {
  const tests = await run(suite.command, {
    cwd: suiteDir(config, suite),
    timeoutMs: 30 * 60 * 1000,
  });
  if (tests.code !== 0) {
    return {
      ok: false,
      feedback: `The test command (\`${suite.command}\`${inDir(suite)}) failed with exit code ${tests.code}. Fix the failures, keeping the plan's intent. Output tail:\n\n${tail(tests.output, 6000)}`,
    };
  }
  if (!suite.coverageEnabled) return { ok: true, feedback: "" };
  return runCoverageGate(config, suite, index);
}

/**
 * Changed-line coverage for one suite. Reports are normalized first (Go
 * coverprofile → LCOV via gcov2lcov; LCOV source paths → repository-relative),
 * then `diff-cover {report} --compare-branch=origin/{default}
 * --fail-under={bar}` from the repository root. Changed files the report
 * doesn't mention (another suite's code) don't count either way.
 */
async function runCoverageGate(
  config: RunnerConfig,
  suite: TestSuite,
  index: number,
): Promise<GateResult> {
  const { project } = config.meta;
  const cwd = suiteDir(config, suite);
  const lcovPath = path.join(".waypoint", `coverage-${index}.lcov`);
  let reportPath = path.join(suite.workdir, suite.coverageReportPath);
  let lcov = suite.coverageFormat === "LCOV";

  if (suite.coverageFormat === "GO_COVERPROFILE") {
    const conv = await run(
      `gcov2lcov -infile '${suite.coverageReportPath}' -outfile '${path.join(config.workspace, lcovPath)}'`,
      { cwd, timeoutMs: 5 * 60 * 1000 },
    );
    if (conv.code !== 0) {
      return {
        ok: false,
        feedback: `Converting the Go coverprofile to LCOV failed — is '${reportPath}' produced by the test command? Output:\n${tail(conv.output)}`,
      };
    }
    reportPath = lcovPath;
    lcov = true;
  }

  if (lcov) {
    // diff-cover only matches LCOV entries whose paths are relative to the
    // repository root; a tool run in a subfolder writes them relative to that
    // folder, and every changed line would silently count as unmeasured.
    let text: string;
    try {
      text = await fs.readFile(path.join(config.workspace, reportPath), "utf8");
    } catch {
      return {
        ok: false,
        feedback: `The test command (\`${suite.command}\`${inDir(suite)}) passed but wrote no coverage report at '${reportPath}'. Make it write one there.`,
      };
    }
    await fs.mkdir(path.join(config.workspace, ".waypoint"), { recursive: true });
    await fs.writeFile(
      path.join(config.workspace, lcovPath),
      normalizeLcov(text, config.workspace, cwd, existsSync),
    );
    reportPath = lcovPath;
  }

  const diff = await run(
    `diff-cover '${reportPath}' --compare-branch='origin/${project.defaultBranch}' --fail-under=${suite.coverageBar}`,
    { cwd: config.workspace, timeoutMs: 5 * 60 * 1000 },
  );
  if (diff.code !== 0) {
    return {
      ok: false,
      feedback: `Changed-line coverage is below the ${suite.coverageBar}% bar (diff-cover vs origin/${project.defaultBranch}). Add tests for the uncovered lines below — do not weaken existing tests.\n\n${tail(diff.output, 6000)}`,
    };
  }
  return { ok: true, feedback: "" };
}

/**
 * Rewrites an LCOV report's `SF:` paths relative to the repository root.
 * Absolute paths are made relative; relative ones are taken from the suite's
 * folder when the file exists there, else from the root.
 */
export function normalizeLcov(
  text: string,
  workspace: string,
  suiteFolder: string,
  exists: (file: string) => boolean,
): string {
  return text
    .split("\n")
    .map((line) => {
      if (!line.startsWith("SF:")) return line;
      const file = line.slice(3).trim();
      const inSuite = path.resolve(suiteFolder, file);
      const absolute =
        path.isAbsolute(file) || exists(inSuite) ? inSuite : path.resolve(workspace, file);
      return `SF:${path.relative(workspace, absolute)}`;
    })
    .join("\n");
}

/** Format then lint (§7) — run after green+covered; findings feed back to the agent. */
export async function runFormatAndLint(config: RunnerConfig): Promise<GateResult> {
  const { project } = config.meta;
  if (project.formatCommand) {
    await run(project.formatCommand, { cwd: config.workspace, timeoutMs: 10 * 60 * 1000 });
  }
  if (project.lintCommand) {
    const lint = await run(project.lintCommand, {
      cwd: config.workspace,
      timeoutMs: 10 * 60 * 1000,
    });
    if (lint.code !== 0) {
      return {
        ok: false,
        feedback: `Lint (\`${project.lintCommand}\`) reported findings — fix them and commit:\n\n${tail(lint.output, 6000)}`,
      };
    }
  }
  return { ok: true, feedback: "" };
}

export const workspaceRel = (config: RunnerConfig, ...parts: string[]) =>
  path.join(config.workspace, ...parts);
