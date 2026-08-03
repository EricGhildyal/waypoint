import Docker from "dockerode";
import { db, emitEvent, getNumberSetting, renderBranchTemplate, transition } from "@waypoint/core";
import type { Task, TaskMeta } from "@waypoint/core";
import { VERIFY_PROMPT_SENTINEL } from "@waypoint/core";
import { env } from "./env";
import { gitPatFor, globalSecret, projectSecretEnv } from "./secrets";

export const docker = new Docker({ socketPath: env.dockerSocket });

export const TASK_LABEL = "waypoint.task";

export function volumeName(taskId: string): string {
  return `waypoint-task-${taskId}`;
}

type TaskWithProject = Task & {
  project: NonNullable<Awaited<ReturnType<typeof db.project.findUnique>>>;
};

async function loadTask(taskId: string): Promise<TaskWithProject> {
  return (await db.task.findUniqueOrThrow({
    where: { id: taskId },
    include: { project: true },
  })) as TaskWithProject;
}

/**
 * Task start (§5): create the workspace volume, start a runner container with
 * label waypoint.task={id}, resource limits from Settings, on the tasks
 * network, secrets decrypted at creation time. QUEUED → PLANNING on success;
 * any Docker error → FAILED with DOCKER_CREATE/DOCKER_START.
 */
export async function startTask(taskId: string): Promise<void> {
  const task = await loadTask(taskId);

  // branch name is host-computed (deterministic) and stored before start
  let branchName = task.branchName;
  if (!branchName) {
    branchName = renderBranchTemplate(task.project.branchTemplate, {
      id: task.id,
      title: task.title,
      difficulty: task.difficulty,
      project: task.project.name,
    });
    await db.task.update({ where: { id: taskId }, data: { branchName } });
  }

  let container: Docker.Container;
  try {
    container = await createTaskContainer(task, branchName);
  } catch (err) {
    await failTask(taskId, "DOCKER_CREATE", err);
    return;
  }

  try {
    await container.start();
  } catch (err) {
    await failTask(taskId, "DOCKER_START", err);
    return;
  }

  await db.task.update({ where: { id: taskId }, data: { containerId: container.id } });
  await transition(taskId, "PLANNING", { currentStage: "PLANNING" });
  console.log(`[docker] started task ${taskId} in container ${container.id.slice(0, 12)}`);
}

/** (Re)create a container for a task whose container disappeared (reconciliation/resume). */
export async function recreateTaskContainer(taskId: string): Promise<void> {
  const task = await loadTask(taskId);
  if (!task.branchName) throw new Error(`task ${taskId} has no branch name`);
  const container = await createTaskContainer(task, task.branchName);
  await container.start();
  await db.task.update({ where: { id: taskId }, data: { containerId: container.id } });
  console.log(`[docker] recreated container for task ${taskId}`);
}

async function createTaskContainer(
  task: TaskWithProject,
  branchName: string,
): Promise<Docker.Container> {
  const memGb = await getNumberSetting("containerMemGb");
  const cpus = await getNumberSetting("containerCpus");

  await ensureVolume(volumeName(task.id));
  await ensureNetwork(env.tasksNetwork);

  const claudeToken = await globalSecret("CLAUDE_CODE_OAUTH_TOKEN");
  const gitPat = await gitPatFor(task.projectId);
  const secrets = await projectSecretEnv(task.projectId);
  delete secrets.GIT_PAT; // delivered separately below

  const meta: TaskMeta = {
    taskId: task.id,
    title: task.title,
    prompt: task.prompt,
    difficulty: task.difficulty,
    branchName,
    verify: task.prompt === VERIFY_PROMPT_SENTINEL,
    models: {
      planning: task.planningModel,
      implementation: task.implementationModel,
      review: task.reviewModel,
      testing: task.testingModel,
    },
    project: {
      name: task.project.name,
      repoUrl: task.project.repoUrl,
      defaultBranch: task.project.defaultBranch,
      setupCommand: task.project.setupCommand,
      runCommand: task.project.runCommand,
      runReadyUrl: task.project.runReadyUrl,
      migrateCommand: task.project.migrateCommand,
      testCommand: task.project.testCommand,
      coverageFormat: task.project.coverageFormat,
      coverageReportPath: task.project.coverageReportPath,
      lintCommand: task.project.lintCommand,
      formatCommand: task.project.formatCommand,
      instructions: task.project.instructions,
      coverageBar: task.project.coverageBar,
    },
  };

  const image = await resolveImage(task);

  return docker.createContainer({
    name: `waypoint-task-${task.id.slice(0, 8)}-${Date.now()}`,
    Image: image,
    Labels: { [TASK_LABEL]: task.id },
    Env: [
      `TASK_ID=${task.id}`,
      `RUNNER_TOKEN=${task.runnerToken}`,
      `HOST_API=${env.runnerHostApi}`,
      `TASK_META=${JSON.stringify(meta)}`,
      ...(claudeToken ? [`CLAUDE_CODE_OAUTH_TOKEN=${claudeToken}`] : []),
      ...(gitPat ? [`GIT_PAT=${gitPat}`] : []),
      ...Object.entries(secrets).map(([k, v]) => `${k}=${v}`),
    ],
    HostConfig: {
      Binds: [`${volumeName(task.id)}:/workspace`, `${env.taskDataVolume}:/data/tasks`],
      NetworkMode: env.tasksNetwork,
      Memory: Math.round(memGb * 1024 ** 3),
      NanoCpus: Math.round(cpus * 1e9),
      // blast radius (§11): no-new-privileges + dropped capabilities. Chromium
      // runs sandbox-less inside this boundary (the container IS the sandbox).
      SecurityOpt: ["no-new-privileges:true"],
      CapDrop: ["ALL"],
      RestartPolicy: { Name: "no" },
    },
  });
}

/**
 * Projects may substitute their own image (must FROM waypoint-runner:latest).
 * The orchestrator doesn't build images; a project with dockerfilePath set uses
 * a pre-built `waypoint-project-{id}` image when present, else the generic one.
 */
async function resolveImage(task: TaskWithProject): Promise<string> {
  if (!task.project.dockerfilePath) return env.runnerImage;
  const custom = `waypoint-project-${task.projectId}`;
  try {
    await docker.getImage(custom).inspect();
    return custom;
  } catch {
    await emitEvent(task.id, "LOG", {
      level: "warn",
      line: `custom image ${custom} not found — using ${env.runnerImage} (build it manually from ${task.project.dockerfilePath})`,
    });
    return env.runnerImage;
  }
}

async function failTask(taskId: string, code: "DOCKER_CREATE" | "DOCKER_START", err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[docker] ${code} for task ${taskId}: ${message}`);
  await emitEvent(taskId, "ERROR", { code, message: message.slice(0, 2000) });
  await transition(taskId, "FAILED", { failureCode: code, failureDetail: message.slice(0, 2000) });
}

export async function ensureVolume(name: string): Promise<void> {
  try {
    await docker.getVolume(name).inspect();
  } catch {
    await docker.createVolume({ Name: name, Labels: { "waypoint.volume": "task" } });
  }
}

export async function ensureNetwork(name: string): Promise<void> {
  try {
    await docker.getNetwork(name).inspect();
  } catch {
    await docker.createNetwork({ Name: name, Driver: "bridge" });
  }
}

export interface WaypointContainer {
  id: string;
  taskId: string;
  running: boolean;
}

export async function listTaskContainers(): Promise<WaypointContainer[]> {
  const containers = await docker.listContainers({
    all: true,
    filters: { label: [TASK_LABEL] },
  });
  return containers.map((c) => ({
    id: c.Id,
    taskId: c.Labels[TASK_LABEL] ?? "",
    running: c.State === "running",
  }));
}

export async function stopContainer(containerId: string): Promise<void> {
  try {
    await docker.getContainer(containerId).stop({ t: 15 });
  } catch {
    /* already stopped/gone */
  }
}

export async function startExistingContainer(containerId: string): Promise<boolean> {
  try {
    await docker.getContainer(containerId).start();
    return true;
  } catch {
    return false;
  }
}

export async function removeContainer(containerId: string): Promise<void> {
  try {
    await docker.getContainer(containerId).remove({ force: true });
  } catch {
    /* already gone */
  }
}

export async function removeVolume(name: string): Promise<void> {
  try {
    await docker.getVolume(name).remove();
  } catch {
    /* in use or gone */
  }
}

export async function isContainerRunning(containerId: string | null): Promise<boolean> {
  if (!containerId) return false;
  try {
    const info = await docker.getContainer(containerId).inspect();
    return info.State.Running;
  } catch {
    return false;
  }
}
