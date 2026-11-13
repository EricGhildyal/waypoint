/** Orchestrator environment knobs, with compose-friendly defaults. */
export const env = {
  dockerSocket: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock",
  /** Runner image the orchestrator starts task containers from. */
  runnerImage: process.env.RUNNER_IMAGE ?? "waypoint-runner:latest",
  /**
   * Container runtime for tasks of projects that run Docker inside the task.
   * Unset, those containers run privileged. Set it to an isolating runtime
   * installed on the host (e.g. "sysbox-runc") to nest Docker without that.
   */
  runnerDockerRuntime: process.env.RUNNER_DOCKER_RUNTIME ?? "",
  /** Network task containers join — reaches web + the internet, nothing else (§11). */
  tasksNetwork: process.env.TASKS_NETWORK ?? "waypoint-tasks",
  /**
   * Where task data lives, as Docker sees it: the named volume shared with web
   * (production), or an absolute host directory (local dev). Each runner gets
   * only its own task's subdirectory of it.
   */
  taskDataVolume: process.env.TASK_DATA_VOLUME ?? "waypoint-task-data",
  /** Base URL runners use to reach the sync endpoint from inside containers. */
  runnerHostApi: process.env.RUNNER_HOST_API ?? "http://web:3000",
  appUrl: process.env.APP_URL ?? "https://waypoint.ergh.co",
  emailFrom: process.env.EMAIL_FROM ?? "waypoint@waypoint.ergh.co",
  inboundDomain: process.env.INBOUND_DOMAIN ?? "waypoint.ergh.co",
  resendApiKey: process.env.RESEND_API_KEY ?? "",
};
