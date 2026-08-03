import type { RunnerConfig } from "./config";
import { run, tail } from "./proc";
import type { StateStore } from "./state";
import type { Syncer } from "./sync";
import { awaitStop } from "./stages";
import { prepareWorkspace } from "./workspace";

/**
 * Verify mode (§9): a throwaway run that clones + setupCommand + testCommand,
 * streaming the log back as events on the synthetic verify task. No agent, no
 * branch, no PR — this is how a project's configuration is validated.
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

  sync.log("info", `verify: running tests: ${config.meta.project.testCommand}`);
  const tests = await run(config.meta.project.testCommand, {
    cwd: config.workspace,
    timeoutMs: 30 * 60 * 1000,
    onLine: (line) => sync.log("debug", line),
  });

  if (tests.code === 0) {
    sync.log("info", "verify: setup + tests succeeded ✔");
  } else {
    sync.log("error", `verify: test command exited ${tests.code}`);
    sync.log("error", tail(tests.output, 480));
  }

  await sync.stageEnd({
    action: "end",
    stage: "PLANNING",
    attempt: 1,
    status: tests.code === 0 ? "SUCCEEDED" : "FAILED",
  });

  state.update({ phase: "AWAIT_STOP" });
  await awaitStop(sync);
}
