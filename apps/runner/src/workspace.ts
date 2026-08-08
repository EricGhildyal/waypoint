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
  const ws = config.workspace;
  const branch = config.meta.branchName;
  const defaultBranch = config.meta.project.defaultBranch;

  const current = await run("git rev-parse --abbrev-ref HEAD", { cwd: ws });
  if (current.output.trim() === branch) return;

  // Switch back to a branch that already exists (restart mid-task) rather than
  // re-pointing it — `checkout -B` would reset it and throw away the work.
  const known = await run(`git rev-parse --verify --quiet 'refs/heads/${branch}'`, { cwd: ws });
  if (known.code === 0) {
    sync.log("info", `switching to branch ${branch}`);
    const res = await run(`git checkout '${branch}'`, { cwd: ws });
    if (res.code !== 0) {
      throw new InfraFailure("GIT_CLONE", "failed to switch to the task branch", tail(res.output));
    }
    return;
  }

  // A brand-new task branch is based on a freshly fetched origin/<default>:
  // planning plus the plan-approval wait can leave the clone hours stale, and
  // every commit of that staleness turns into a conflict at PR time.
  const fetched = await run(`git fetch origin '${defaultBranch}'`, {
    cwd: ws,
    timeoutMs: 5 * 60 * 1000,
  });
  if (fetched.code !== 0) {
    sync.log("warn", `could not fetch origin/${defaultBranch} — branching from the local checkout`);
  }
  sync.log("info", `creating branch ${branch}`);
  if (fetched.code === 0) {
    const fresh = await run(`git checkout -B '${branch}' 'origin/${defaultBranch}'`, { cwd: ws });
    if (fresh.code === 0) return;
    // e.g. the setup command left a tracked file modified that also moved
    // upstream — never worse than before: fall back to today's local branch
    sync.log(
      "warn",
      `could not base ${branch} on origin/${defaultBranch} — branching from the local checkout:\n${tail(fresh.output, 500)}`,
    );
  }

  const res = await run(`git checkout -B '${branch}'`, { cwd: ws });
  if (res.code !== 0) {
    throw new InfraFailure("GIT_CLONE", "failed to create task branch", tail(res.output));
  }
}

export type SyncOutcome = "up-to-date" | "merged" | "conflicts" | "skipped";

/**
 * Bring the task branch up to date with the branch the PR will target, right
 * before the push (§7) — main has usually moved on since the branch was cut, and
 * a PR that opens with conflicts is the user's problem to untangle by hand.
 *
 * Merge, not rebase: one conflict pass instead of one per commit, no rewritten
 * history, no force-push, and re-running it after a crash is harmless.
 *
 * Returns "conflicts" with the merge deliberately left in progress for the
 * conflict-resolution agent to finish. Everything that can go wrong degrades to
 * "skipped", i.e. exactly today's behavior: push unsynced and let GitHub say so.
 */
export async function syncWithDefaultBranch(
  config: RunnerConfig,
  sync: Syncer,
): Promise<SyncOutcome> {
  const ws = config.workspace;
  const defaultBranch = config.meta.project.defaultBranch;

  await abortLeftoverMerge(config);

  const fetched = await run(`git fetch origin '${defaultBranch}'`, {
    cwd: ws,
    timeoutMs: 5 * 60 * 1000,
  });
  if (fetched.code !== 0) {
    sync.log(
      "warn",
      `could not fetch origin/${defaultBranch} — pushing without syncing:\n${tail(fetched.output, 500)}`,
    );
    return "skipped";
  }

  const behind = await run(`git rev-list --count 'HEAD..origin/${defaultBranch}'`, { cwd: ws });
  if (behind.code === 0 && behind.output.trim() === "0") {
    sync.log("info", `already up to date with origin/${defaultBranch}`);
    return "up-to-date";
  }

  sync.log("info", `merging origin/${defaultBranch} into ${config.meta.branchName}`);
  const merge = await run(`git merge --no-edit 'origin/${defaultBranch}'`, {
    cwd: ws,
    timeoutMs: 5 * 60 * 1000,
  });
  if (merge.code === 0) return "merged";

  const conflicts = await conflictedFiles(config);
  if (conflicts.length === 0) {
    // failed for some reason other than conflicts — put the tree back and push
    await abortLeftoverMerge(config);
    sync.log(
      "warn",
      `merging origin/${defaultBranch} failed without conflicts — pushing without syncing:\n${tail(merge.output, 500)}`,
    );
    return "skipped";
  }
  sync.log("warn", `merge conflicts in ${conflicts.length} file(s) — resolving with an agent`);
  return "conflicts";
}

/**
 * Throw away a merge left half-finished by a crashed (or given-up) conflict
 * resolution. Returns whether there was one.
 *
 * This runs at runner boot as well as before each sync, because an in-progress
 * merge is live ammunition: `git commit` during one concludes it, so the very
 * next commitLeftovers() would bake the conflict markers into a commit and push
 * them. Whoever touches git first after a restart has to clear it.
 */
export async function abortLeftoverMerge(config: RunnerConfig): Promise<boolean> {
  if (!(await mergeInProgress(config))) return false;
  await run("git merge --abort 2>/dev/null || true", { cwd: config.workspace });
  return true;
}

/** Files left unmerged by an in-progress merge. */
export async function conflictedFiles(config: RunnerConfig): Promise<string[]> {
  const res = await run("git diff --name-only --diff-filter=U", { cwd: config.workspace });
  return res.output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** True while a merge is started but not yet committed or aborted. */
export function mergeInProgress(config: RunnerConfig): Promise<boolean> {
  return exists(path.join(config.workspace, ".git", "MERGE_HEAD"));
}

/** Commit anything the agent left uncommitted (safety net before review/push). */
export async function commitLeftovers(config: RunnerConfig, message: string): Promise<void> {
  // `git commit` during a conflicted merge concludes it — with the conflict
  // markers as content. This safety net must never be the thing that does that;
  // clearing the merge belongs to abortLeftoverMerge.
  if (await mergeInProgress(config)) return;
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
