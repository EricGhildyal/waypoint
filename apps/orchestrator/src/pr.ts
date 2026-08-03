import { promises as fs } from "node:fs";
import { Octokit } from "octokit";
import { artifactPath, db, emitEvent, transition } from "@waypoint/core";
import { gitPatFor } from "./secrets";

/**
 * Open PRs for tasks in OPENING_PR (§7): the runner pushed the branch; the
 * orchestrator opens the PR via Octokit. Body = pr.md verbatim — a short
 * summary of the changes plus special-implementation-detail notes, nothing
 * else. → DONE (email follows from the status change).
 */
export async function openPendingPrs(): Promise<void> {
  const tasks = await db.task.findMany({
    where: { status: "OPENING_PR" },
    include: { project: true },
  });

  for (const task of tasks) {
    try {
      const repo = parseGithubRepo(task.project.repoUrl);
      if (!repo) throw new Error(`unsupported repo URL: ${task.project.repoUrl}`);
      if (!task.branchName) throw new Error("task has no branch name");

      const pat = await gitPatFor(task.projectId);
      if (!pat) throw new Error("no GitHub PAT configured (project GIT_PAT or global)");

      const body = await readPrBody(task.id);
      const octokit = new Octokit({ auth: pat });
      const { data: pr } = await octokit.rest.pulls.create({
        owner: repo.owner,
        repo: repo.repo,
        head: task.branchName,
        base: task.project.defaultBranch,
        title: task.title,
        body,
      });

      await db.task.update({ where: { id: task.id }, data: { prUrl: pr.html_url } });
      await emitEvent(task.id, "PR_OPENED", { url: pr.html_url });
      await transition(task.id, "DONE", { reason: pr.html_url });
      console.log(`[pr] opened ${pr.html_url} for task ${task.id}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[pr] failed for task ${task.id}: ${message}`);
      await emitEvent(task.id, "ERROR", { code: "PR_FAILED", message: message.slice(0, 2000) });
      await transition(task.id, "FAILED", {
        failureCode: "PR_FAILED",
        failureDetail: message.slice(0, 2000),
      });
    }
  }
}

async function readPrBody(taskId: string): Promise<string> {
  try {
    return await fs.readFile(artifactPath(taskId, "pr.md"), "utf8");
  } catch {
    return "Automated change by Waypoint.";
  }
}

export function parseGithubRepo(repoUrl: string): { owner: string; repo: string } | null {
  const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(repoUrl);
  if (!match || !match[1] || !match[2]) return null;
  return { owner: match[1], repo: match[2] };
}
