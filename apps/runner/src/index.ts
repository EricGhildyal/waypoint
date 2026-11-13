import { writeComposeEnvFiles } from "./compose-env";
import { loadConfig } from "./config";
import { startDockerd } from "./dockerd";
import { StateStore } from "./state";
import {
  awaitFindingsApproval,
  awaitPlanApproval,
  awaitStop,
  runImplementation,
  runPlanning,
  runPrFeedback,
  runReview,
  runTesting,
} from "./stages";
import { StopRequested, Syncer } from "./sync";
import { runVerify } from "./verify";
import { InfraFailure, abortLeftoverMerge, prepareWorkspace } from "./workspace";

/**
 * The runner (§6): executes the pipeline inside its task container. Its ONLY
 * channel to the host is POST /sync. All progress is checkpointed to
 * /workspace/.waypoint/state.json so a stopped/recreated container resumes
 * exactly where it left off (sessions resumed by id).
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const state = new StateStore(config.workspace);
  const sync = new Syncer(config, state);
  sync.start();

  try {
    await startDockerd(sync);

    if (config.meta.verify) {
      await runVerify(config, sync, state);
      await finish(sync, 0);
      return;
    }

    if (!state.get().setupDone) {
      await prepareWorkspace(config, sync);
      state.update({
        setupDone: true,
        phase: state.get().phase === "SETUP" ? "PLANNING" : state.get().phase,
      });
    } else {
      // a recreated container: refresh the env files with its current secrets
      await writeComposeEnvFiles(config, sync);
    }

    // A container that died during the pre-push sync leaves a conflicted merge
    // on the volume. Clear it before any stage touches git: a stage that
    // commits (commitLeftovers) would otherwise conclude that merge and push
    // the conflict markers.
    if (await abortLeftoverMerge(config)) {
      sync.log("warn", "discarded a merge left in progress by a previous container");
    }

    // One PR-feedback round per process: the host stops the container after
    // each round and starts it again for the next one.
    let feedbackDone = false;

    pipeline: for (;;) {
      switch (state.get().phase) {
        case "SETUP":
        case "PLANNING":
          await runPlanning(config, sync, state);
          break;
        case "AWAIT_PLAN":
          await awaitPlanApproval(config, sync, state);
          break;
        case "IMPLEMENTING":
          await runImplementation(config, sync, state);
          break;
        case "REVIEW":
          await runReview(config, sync, state);
          break;
        case "AWAIT_FINDINGS":
          await awaitFindingsApproval(config, sync, state);
          break;
        case "TESTING":
        case "PUSH": // push crashed mid-way — re-run the testing tail
          await runTesting(config, sync, state);
          break;
        case "AWAIT_STOP":
          if ((await awaitStop(sync, !feedbackDone)) === "stop") break pipeline;
          state.update({ phase: "PR_FEEDBACK" });
          break;
        case "PR_FEEDBACK":
          await runPrFeedback(config, sync, state);
          feedbackDone = true;
          break;
      }
    }
    await finish(sync, 0);
  } catch (err) {
    if (err instanceof StopRequested) {
      console.log("[runner] stop requested by host — exiting");
      await finish(sync, 0);
      return;
    }
    if (err instanceof InfraFailure) {
      console.error(`[runner] infra failure ${err.code}: ${err.message}`);
      sync.error(err.code, err.message, err.logTail);
      await finish(sync, 1);
      return;
    }
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(`[runner] crash: ${message}`);
    sync.error("RUNNER_CRASH", message.slice(0, 2000));
    await finish(sync, 1);
  }
}

async function finish(sync: Syncer, code: number): Promise<void> {
  try {
    await sync.flush();
  } catch {
    /* best effort */
  }
  sync.stop();
  process.exit(code);
}

void main();
