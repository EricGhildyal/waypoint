import { promises as fs } from "node:fs";
import { Octokit } from "octokit";
import { artifactPath, db, emitEvent, transition } from "@waypoint/core";
import { gitBotTokenFor, gitPatFor } from "./secrets";

/**
 * Open PRs for tasks in OPENING_PR (§7): the runner pushed the branch; the
 * orchestrator opens the PR via Octokit. Body = pr.md verbatim — a short
 * summary of the changes plus special-implementation-detail notes, nothing
 * else. → PR_OPEN, where pollOpenPrs (pr-poll.ts) watches it until it merges.
 *
 * Opened with the bot token when there is one, so the human is not the PR's
 * author and can approve it.
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

      const token = await githubTokenFor(task.projectId);
      if (!token) throw new Error("no GitHub token configured (bot token or PAT)");

      const body = await readPrBody(task.id);
      const octokit = new Octokit({ auth: token });
      // A retry can arrive here with the PR already open: it was created, and
      // then recording it failed. Creating it again is a 422 every time, so
      // look for it first and adopt it.
      const { data: existing } = await octokit.rest.pulls.list({
        owner: repo.owner,
        repo: repo.repo,
        head: `${repo.owner}:${task.branchName}`,
        state: "open",
      });
      const pr =
        existing[0] ??
        (
          await octokit.rest.pulls.create({
            owner: repo.owner,
            repo: repo.repo,
            head: task.branchName,
            base: task.project.defaultBranch,
            title: task.title,
            body,
          })
        ).data;

      await db.task.update({
        where: { id: task.id },
        // comments older than the PR cannot exist, so the cursor starts here
        data: { prUrl: pr.html_url, prNumber: pr.number, prFeedbackCursor: new Date() },
      });
      await emitEvent(task.id, "PR_OPENED", { url: pr.html_url });
      await transition(task.id, "PR_OPEN", { reason: pr.html_url });
      console.log(`[pr] opened ${pr.html_url} for task ${task.id}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[pr] failed for task ${task.id}: ${message}`);
      // the task may have been cancelled meanwhile — that must not abort the
      // rest of this tick
      try {
        await emitEvent(task.id, "ERROR", { code: "PR_FAILED", message: message.slice(0, 2000) });
        await transition(task.id, "FAILED", {
          failureCode: "PR_FAILED",
          failureDetail: message.slice(0, 2000),
        });
      } catch (inner) {
        console.error(`[pr] could not record the failure for task ${task.id}: ${String(inner)}`);
      }
    }
  }
}

/** The token Waypoint acts on GitHub with: the bot's when configured, else the PAT. */
export async function githubTokenFor(projectId: string): Promise<string | null> {
  return (await gitBotTokenFor(projectId)) ?? (await gitPatFor(projectId));
}

export async function readPrBody(taskId: string): Promise<string> {
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
