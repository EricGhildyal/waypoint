import path from "node:path";

/**
 * Task-data layout on the shared `task-data` volume (§3):
 *   /data/tasks/{taskId}/{stage}-{attempt}.jsonl        transcripts (runner-written)
 *   /data/tasks/{taskId}/artifacts/{name}               plan.md, pr.md, findings (web-written)
 * Web + orchestrator mount the volume at /data/tasks; the runner mounts it at
 * the same path so transcriptPath values are valid everywhere.
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
