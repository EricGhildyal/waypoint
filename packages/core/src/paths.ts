import path from "node:path";

/**
 * Task-data layout on the shared `task-data` volume (§3):
 *   /data/tasks/{taskId}/{stage}-{attempt}.jsonl        transcripts (runner-written)
 *   /data/tasks/{taskId}/artifacts/{name}               plan.md, pr.md, findings (web-written)
 * Web + orchestrator mount the volume at /data/tasks. A runner gets only its
 * own task's directory, mounted at the same path (/data/tasks/{taskId}), so
 * transcriptPath values are valid everywhere without one task being able to
 * read or write another's files.
 */
export const TASK_DATA_DIR = process.env.TASK_DATA_DIR ?? "/data/tasks";

export function taskDataDir(taskId: string): string {
  return path.join(TASK_DATA_DIR, taskId);
}

export function transcriptPath(taskId: string, stage: string, attempt: number): string {
  return path.join(taskDataDir(taskId), `${stage.toLowerCase()}-${attempt}.jsonl`);
}

export function artifactDir(taskId: string): string {
  return path.join(taskDataDir(taskId), "artifacts");
}

export function artifactPath(taskId: string, name: string): string {
  // names come from the runner — keep them to a single path segment
  return path.join(artifactDir(taskId), path.basename(name));
}

/**
 * Artifacts that carry a pull-request feedback round between the orchestrator
 * (which talks to GitHub) and the runner (which does the work):
 *   pr-feedback.md  orchestrator → runner: the comments to address
 *   pr-reply.md     runner → orchestrator: the comment to post back
 */
export const PR_FEEDBACK_ARTIFACT = "pr-feedback.md";
export const PR_REPLY_ARTIFACT = "pr-reply.md";
