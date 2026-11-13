import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { run, tail } from "./proc";
import type { Syncer } from "./sync";
import { InfraFailure } from "./workspace";

const LOG = "/var/log/dockerd.log";

/** Whether this task's project opted into Docker (the orchestrator sets it). */
export const dockerEnabled = (): boolean => process.env.RUNNER_DOCKER === "1";

/**
 * Start the Docker daemon nested in this container, for projects whose app is
 * a compose stack. It runs entirely inside the task: its images, containers
 * and networks live on the task's own volume, count against the task's memory
 * and CPU limits, and publish ports on this container's localhost — which is
 * where the ready check and the browser tests look.
 *
 * Runs on every process start: a stopped container loses its daemon.
 */
export async function startDockerd(sync: Syncer): Promise<void> {
  if (!dockerEnabled()) return;
  if ((await run("docker info", { cwd: "/" })).code === 0) return;

  sync.log("info", "starting Docker inside the task container");
  // pid files outlive a stopped container and make the daemon refuse to start
  await run("rm -f /var/run/docker.pid /run/docker/containerd/containerd.pid", { cwd: "/" });
  const log = openSync(LOG, "a");
  const child = spawn("dind", ["dockerd"], { stdio: ["ignore", log, log], detached: true });
  closeSync(log);
  const daemon: { exited: number | null } = { exited: null };
  child.on("exit", (code) => {
    daemon.exited = code ?? 1;
  });
  child.on("error", () => {
    daemon.exited = 127;
  });
  child.unref();

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && daemon.exited === null) {
    if ((await run("docker info", { cwd: "/" })).code === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const output = (await run(`tail -n 40 ${LOG}`, { cwd: "/" })).output;
  throw new InfraFailure(
    "DOCKER_START",
    daemon.exited === null
      ? "Docker did not start inside the task container within 60s"
      : `Docker exited (${daemon.exited}) while starting inside the task container`,
    tail(output),
  );
}
