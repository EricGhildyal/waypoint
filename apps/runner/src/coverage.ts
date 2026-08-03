import path from "node:path";
import type { RunnerConfig } from "./config";
import { run, tail } from "./proc";

export interface GateResult {
  ok: boolean;
  feedback: string;
}

/**
 * The coverage gate (§7): run testCommand → all green AND changed-line
 * coverage ≥ coverageBar. Reports are normalized per coverageFormat first
 * (Go coverprofile → LCOV via gcov2lcov; the rest are read natively by
 * diff-cover), then `diff-cover {report} --compare-branch=origin/{default}
 * --fail-under={bar}`. Failures come back as agent feedback, not verdicts.
 * A project without a testCommand has no gate — pass unconditionally.
 */
export async function runTestGate(config: RunnerConfig): Promise<GateResult> {
  const { project } = config.meta;
  if (!project.testCommand) return { ok: true, feedback: "" };
  const tests = await run(project.testCommand, {
    cwd: config.workspace,
    timeoutMs: 30 * 60 * 1000,
  });
  if (tests.code !== 0) {
    return {
      ok: false,
      feedback: `The test command (\`${project.testCommand}\`) failed with exit code ${tests.code}. Fix the failures, keeping the plan's intent. Output tail:\n\n${tail(tests.output, 6000)}`,
    };
  }

  const coverage = await runCoverageGate(config);
  if (!coverage.ok) return coverage;

  return { ok: true, feedback: "" };
}

export async function runCoverageGate(config: RunnerConfig): Promise<GateResult> {
  const { project } = config.meta;
  let reportPath = project.coverageReportPath;

  if (project.coverageFormat === "GO_COVERPROFILE") {
    const lcovPath = ".waypoint/coverage.lcov";
    const conv = await run(`gcov2lcov -infile '${reportPath}' -outfile '${lcovPath}'`, {
      cwd: config.workspace,
      timeoutMs: 5 * 60 * 1000,
    });
    if (conv.code !== 0) {
      return {
        ok: false,
        feedback: `Converting the Go coverprofile to LCOV failed — is '${reportPath}' produced by the test command? Output:\n${tail(conv.output)}`,
      };
    }
    reportPath = lcovPath;
  }

  const diff = await run(
    `diff-cover '${reportPath}' --compare-branch='origin/${project.defaultBranch}' --fail-under=${project.coverageBar}`,
    { cwd: config.workspace, timeoutMs: 5 * 60 * 1000 },
  );
  if (diff.code !== 0) {
    return {
      ok: false,
      feedback: `Changed-line coverage is below the ${project.coverageBar}% bar (diff-cover vs origin/${project.defaultBranch}). Add tests for the uncovered lines below — do not weaken existing tests.\n\n${tail(diff.output, 6000)}`,
    };
  }
  return { ok: true, feedback: "" };
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
