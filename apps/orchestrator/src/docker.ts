import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import Docker from "dockerode";
import {
  db,
  emitEvent,
  getNumberSetting,
  getSetting,
  renderBranchTemplate,
  taskDataDir,
  transition,
} from "@waypoint/core";
import type { Task, TaskMeta } from "@waypoint/core";
import { VERIFY_PROMPT_SENTINEL, parseTestSuites } from "@waypoint/core";
import { env } from "./env";
import { gitBotTokenFor, gitPatFor, globalSecret, projectSecretEnv } from "./secrets";

export const docker = new Docker({ socketPath: env.dockerSocket });

export const TASK_LABEL = "waypoint.task";
/** Hash of the credentials a container was created with — see secretsFingerprint(). */
const SECRETS_LABEL = "waypoint.secrets";

export function volumeName(taskId: string): string {
  return `waypoint-task-${taskId}`;
}

/** The nested Docker daemon's storage, for tasks of projects that enable it. */
export function dockerVolumeName(taskId: string): string {
  return `waypoint-task-${taskId}-docker`;
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

  const { claudeToken, gitPat, secrets } = await taskSecrets(task.projectId);
  const nestedDocker = task.project.dockerEnabled;
  // The daemon's storage can't sit on the container's own overlay filesystem,
  // and on a volume the images it builds survive a retry.
  if (nestedDocker) await ensureVolume(dockerVolumeName(task.id));

  const meta: TaskMeta = {
    taskId: task.id,
    title: task.title,
    prompt: task.prompt,
    difficulty: task.difficulty,
    branchName,
    verify: task.prompt === VERIFY_PROMPT_SENTINEL,
    skipTesting: task.skipTesting,
    autoApprovePlan:
      task.difficulty === "EASY" && (await getSetting("autoApproveEasyPlans")) !== "false",
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
      testSuites: parseTestSuites(task.project.testSuites),
      lintCommand: task.project.lintCommand,
      formatCommand: task.project.formatCommand,
      instructions: task.project.instructions,
    },
  };

  const image = await resolveImage(task);

  return docker.createContainer({
    name: `waypoint-task-${task.id.slice(0, 8)}-${Date.now()}`,
    Image: image,
    Labels: {
      [TASK_LABEL]: task.id,
      [SECRETS_LABEL]: fingerprint({ claudeToken, gitPat, secrets }, nestedDocker),
    },
    Env: [
      `TASK_ID=${task.id}`,
      `RUNNER_TOKEN=${task.runnerToken}`,
      `HOST_API=${env.runnerHostApi}`,
      `TASK_META=${JSON.stringify(meta)}`,
      ...(claudeToken ? [`CLAUDE_CODE_OAUTH_TOKEN=${claudeToken}`] : []),
      ...(gitPat ? [`GIT_PAT=${gitPat}`] : []),
      // names only: which of the variables below the runner copies into the
      // env files a compose stack reads
      ...(nestedDocker
        ? ["RUNNER_DOCKER=1", `PROJECT_SECRET_KEYS=${Object.keys(secrets).join(",")}`]
        : []),
      ...Object.entries(secrets).map(([k, v]) => `${k}=${v}`),
    ],
    HostConfig: {
      Binds: [
        `${volumeName(task.id)}:/workspace`,
        ...(nestedDocker ? [`${dockerVolumeName(task.id)}:/var/lib/docker`] : []),
      ],
      ...(nestedDocker ? nestedDockerHostConfig() : {}),
      Mounts: [await taskDataMount(task.id)],
      NetworkMode: env.tasksNetwork,
      Memory: Math.round(memGb * 1024 ** 3),
      NanoCpus: Math.round(cpus * 1e9),
      RestartPolicy: { Name: "no" },
    },
  });
}

/** Where the runner expects its task-data directory (TASK_DATA_DIR/{taskId}). */
const RUNNER_TASK_DATA = "/data/tasks";

/**
 * The runner's view of the task-data store: its own task's directory and
 * nothing else. Agents run with every permission, so mounting the whole store
 * would let one task read every other task's transcripts and plans, and write
 * another task's PR reply or feedback file — text the orchestrator posts to
 * GitHub or hands to another agent as the user's own words.
 */
async function taskDataMount(taskId: string): Promise<Docker.MountSettings> {
  // The orchestrator sees the store at TASK_DATA_DIR. The directory must exist
  // before the container starts: neither mount type creates it.
  await fs.mkdir(taskDataDir(taskId), { recursive: true });
  const Target = `${RUNNER_TASK_DATA}/${taskId}`;

  // local dev (`make run`): the "volume" is a host directory
  if (path.isAbsolute(env.taskDataVolume)) {
    return { Type: "bind", Source: path.join(env.taskDataVolume, taskId), Target };
  }

  // A named volume is narrowed with a subpath mount, which the daemon must
  // understand — an older one would silently mount the whole volume at the
  // task's path instead. Refuse rather than run unisolated.
  const { ApiVersion } = await docker.version();
  if (Number.parseFloat(ApiVersion) < 1.45) {
    throw new Error(
      `Docker API ${ApiVersion} cannot mount a volume subpath — task isolation needs Docker 26 or newer`,
    );
  }
  return {
    Type: "volume",
    Source: env.taskDataVolume,
    Target,
    VolumeOptions: { Subpath: taskId },
  } as Docker.MountSettings;
}

/**
 * What a container needs to run its own Docker daemon. Privileged by default,
 * which lets a process in the container reach the host — the agent included,
 * so it is granted per project, never to every task. An isolating runtime
 * (RUNNER_DOCKER_RUNTIME, e.g. sysbox-runc) nests Docker without it.
 */
function nestedDockerHostConfig(): Partial<Docker.HostConfig> {
  return env.runnerDockerRuntime ? { Runtime: env.runnerDockerRuntime } : { Privileged: true };
}

interface TaskSecrets {
  claudeToken: string | null;
  gitPat: string | null;
  secrets: Record<string, string>;
}

/** The credentials a task's container is given, decrypted. */
async function taskSecrets(projectId: string): Promise<TaskSecrets> {
  const claudeToken = await globalSecret("CLAUDE_CODE_OAUTH_TOKEN");
  // Clone and push as the bot when there is one: the human's own PAT then
  // never enters a container where an agent runs with every permission.
  const gitPat = (await gitBotTokenFor(projectId)) ?? (await gitPatFor(projectId));
  const secrets = await projectSecretEnv(projectId);
  delete secrets.GIT_PAT; // delivered separately
  delete secrets.GIT_BOT_PAT; // host-only: opens, comments on and merges PRs
  return { claudeToken, gitPat, secrets };
}

function fingerprint({ claudeToken, gitPat, secrets }: TaskSecrets, nestedDocker: boolean): string {
  const entries = Object.entries(secrets).toSorted(([a], [b]) => a.localeCompare(b));
  // Docker access is fixed at creation like the credentials are, so switching
  // it on a project has to replace the container too. Left out when off, so
  // the containers of projects that never use it keep their fingerprint.
  const parts = [claudeToken, gitPat, entries, ...(nestedDocker ? ["docker"] : [])];
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/**
 * What a container for this task would be labelled if created now. A stopped
 * container whose label differs was created with credentials that have since
 * been rotated; its environment is fixed, so it has to be recreated.
 */
export async function secretsFingerprint(taskId: string): Promise<string> {
  const task = await loadTask(taskId);
  return fingerprint(await taskSecrets(task.projectId), task.project.dockerEnabled);
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
  /** undefined for containers created before the label existed */
  secrets: string | undefined;
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
    secrets: c.Labels[SECRETS_LABEL],
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
