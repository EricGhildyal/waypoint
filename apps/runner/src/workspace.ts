import { promises as fs } from "node:fs";
import path from "node:path";
import type { RunnerConfig } from "./config";
import { run, tail } from "./proc";
import type { Syncer } from "./sync";

export class InfraFailure extends Error {
  constructor(
    public readonly code: "GIT_CLONE" | "SETUP_COMMAND" | "PUSH_FAILED",
    message: string,
    public readonly logTail: string,
  ) {
    super(message);
  }
}

/** repoUrl with the PAT embedded for clone/fetch/push. */
export function authedRepoUrl(repoUrl: string): string {
  const pat = process.env.GIT_PAT;
  if (!pat) return repoUrl;
  try {
    const url = new URL(repoUrl);
    url.username = "x-access-token";
    url.password = pat;
    return url.toString();
  } catch {
    return repoUrl;
  }
}

/**
 * Idempotent workspace preparation (§5 task start): fetch the repo into
 * /workspace, run setupCommand (+ migrateCommand), write the setup-done
 * marker. Safe to re-run after a crash at any point.
 */
export async function prepareWorkspace(config: RunnerConfig, sync: Syncer): Promise<void> {
  const ws = config.workspace;
  const project = config.meta.project;
  const marker = path.join(ws, ".waypoint-setup-done");

  if (await exists(marker)) {
    sync.log("info", "workspace already prepared — resuming");
    return;
  }

  sync.log("info", `cloning ${project.repoUrl} (${project.defaultBranch})`);
  const url = authedRepoUrl(project.repoUrl);
  // init+fetch instead of clone: idempotent when a previous attempt died midway
  const cloneScript = [
    `git init -q .`,
    `git remote remove origin 2>/dev/null || true`,
    `git remote add origin '${url}'`,
    `git fetch origin '${project.defaultBranch}'`,
    `git checkout -f -B '${project.defaultBranch}' 'origin/${project.defaultBranch}'`,
    `git config user.name 'Waypoint'`,
    `git config user.email 'waypoint@local'`,
    `printf '/.waypoint\\n/.waypoint-setup-done\\n' >> .git/info/exclude`,
  ].join(" && ");
  const clone = await run(cloneScript, { cwd: ws, timeoutMs: 10 * 60 * 1000 });
  if (clone.code !== 0) {
    throw new InfraFailure(
      "GIT_CLONE",
      `git clone failed (exit ${clone.code})`,
      tail(clone.output),
    );
  }

  sync.log("info", `running setup: ${project.setupCommand}`);
  const setup = await run(project.setupCommand, {
    cwd: ws,
    timeoutMs: 20 * 60 * 1000,
    onLine: (line) => sync.log("debug", line),
  });
  if (setup.code !== 0) {
    throw new InfraFailure(
      "SETUP_COMMAND",
      `setup command failed (exit ${setup.code})`,
      tail(setup.output),
    );
  }

  if (project.migrateCommand) {
    sync.log("info", `running migrations: ${project.migrateCommand}`);
    const migrate = await run(project.migrateCommand, {
      cwd: ws,
      timeoutMs: 10 * 60 * 1000,
      onLine: (line) => sync.log("debug", line),
    });
    if (migrate.code !== 0) {
      throw new InfraFailure(
        "SETUP_COMMAND",
        `migrate command failed (exit ${migrate.code})`,
        tail(migrate.output),
      );
    }
  }

  await fs.writeFile(marker, new Date().toISOString());
  sync.log("info", "workspace ready");
}

/** Create/switch to the task branch (implementation stage, §7). */
export async function ensureBranch(config: RunnerConfig, sync: Syncer): Promise<void> {
  const current = await run("git rev-parse --abbrev-ref HEAD", { cwd: config.workspace });
  if (current.output.trim() === config.meta.branchName) return;
  sync.log("info", `creating branch ${config.meta.branchName}`);
  const res = await run(`git checkout -B '${config.meta.branchName}'`, { cwd: config.workspace });
  if (res.code !== 0) {
    throw new InfraFailure("GIT_CLONE", "failed to create task branch", tail(res.output));
  }
}

/** Commit anything the agent left uncommitted (safety net before review/push). */
export async function commitLeftovers(config: RunnerConfig, message: string): Promise<void> {
  const status = await run("git status --porcelain", { cwd: config.workspace });
  if (!status.output.trim()) return;
  await run(`git add -A && git commit -q -m '${message.replaceAll("'", "'\\''")}'`, {
    cwd: config.workspace,
  });
}

export async function pushBranch(config: RunnerConfig, sync: Syncer): Promise<void> {
  sync.log("info", `pushing ${config.meta.branchName}`);
  const res = await run(`git push -u origin '${config.meta.branchName}'`, {
    cwd: config.workspace,
    timeoutMs: 5 * 60 * 1000,
  });
  if (res.code !== 0) {
    throw new InfraFailure("PUSH_FAILED", `git push failed (exit ${res.code})`, tail(res.output));
  }
}

export async function readWorkspaceFile(
  config: RunnerConfig,
  relative: string,
): Promise<string | null> {
  try {
    return await fs.readFile(path.join(config.workspace, relative), "utf8");
  } catch {
    return null;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
