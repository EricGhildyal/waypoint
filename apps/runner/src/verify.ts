import { existsSync } from "node:fs";
import path from "node:path";
import type { RunnerConfig } from "./config";
import { suiteDir } from "./coverage";
import { run, tail } from "./proc";
import type { StateStore } from "./state";
import type { Syncer } from "./sync";
import { awaitStop } from "./stages";
import { prepareWorkspace } from "./workspace";

/**
 * Verify mode (§9): a throwaway run that clones + setupCommand + every test suite
 * (skipped when the project has none), streaming the log back as events on the
 * synthetic verify task. No agent, no branch, no PR — this is how a project's
 * configuration is validated.
 */
export async function runVerify(
  config: RunnerConfig,
  sync: Syncer,
  state: StateStore,
): Promise<void> {
  await sync.stageStart({
    action: "start",
    stage: "PLANNING",
    attempt: 1,
    model: config.meta.models.planning,
  });

  await prepareWorkspace(config, sync); // throws InfraFailure on clone/setup errors

  const suites = config.meta.project.testSuites;
  let ok = true;
  for (const suite of suites) {
    const cwd = suiteDir(config, suite);
    sync.log("info", `verify: running test suite "${suite.name}": ${suite.command}`);
    const tests = await run(suite.command, {
      cwd,
      timeoutMs: 30 * 60 * 1000,
      onLine: (line) => sync.log("debug", line),
    });
    if (tests.code !== 0) {
      ok = false;
      sync.log("error", `verify: test suite "${suite.name}" exited ${tests.code}`);
      sync.log("error", tail(tests.output, 480));
      continue;
    }
    // the coverage check itself needs a diff; the report being there is what
    // a project's configuration can get wrong
    if (suite.coverageEnabled && !existsSync(path.join(cwd, suite.coverageReportPath))) {
      ok = false;
      sync.log(
        "error",
        `verify: test suite "${suite.name}" passed but wrote no coverage report at ${path.join(suite.workdir, suite.coverageReportPath)} — fix the report path or turn coverage off for this suite`,
      );
    }
  }
  if (!suites.length) {
    sync.log(
      "info",
      "verify: no test suites configured — skipping tests (clone + setup verified) ✔",
    );
  } else if (ok) {
    sync.log("info", "verify: setup + tests succeeded ✔");
  }

  await sync.stageEnd({
    action: "end",
    stage: "PLANNING",
    attempt: 1,
    status: ok ? "SUCCEEDED" : "FAILED",
  });

  state.update({ phase: "AWAIT_STOP" });
  await awaitStop(sync, false);
}
