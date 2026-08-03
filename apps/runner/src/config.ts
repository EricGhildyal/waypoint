import type { TaskMeta } from "./types";

export interface RunnerConfig {
  taskId: string;
  runnerToken: string;
  hostApi: string;
  meta: TaskMeta;
  workspace: string;
  /** transcript + artifact root on the shared task-data volume */
  taskDataDir: string;
}

export function loadConfig(): RunnerConfig {
  const taskId = required("TASK_ID");
  const runnerToken = required("RUNNER_TOKEN");
  const hostApi = process.env.HOST_API ?? "http://web:3000";
  const meta = JSON.parse(required("TASK_META")) as TaskMeta;
  return {
    taskId,
    runnerToken,
    hostApi,
    meta,
    workspace: process.env.WORKSPACE_DIR ?? "/workspace",
    taskDataDir: `${process.env.TASK_DATA_DIR ?? "/data/tasks"}/${taskId}`,
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var ${name}`);
  return value;
}
