import { db, getAllSettings } from "@waypoint/core";
import { NewTaskForm } from "./new-task-form";

export const dynamic = "force-dynamic";

export default async function NewTaskPage({
  searchParams,
}: {
  /** `?project=<id>` preselects it — how a project page links here. */
  searchParams: Promise<{ project?: string }>;
}) {
  const { project } = await searchParams;
  const [projects, settings, recentTasks] = await Promise.all([
    db.project.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    getAllSettings(),
    db.task.findMany({
      where: { status: { notIn: ["DONE", "FAILED", "CANCELLED"] } },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { id: true, title: true, status: true },
    }),
  ]);
  let models: string[] = [];
  try {
    models = JSON.parse(settings.models ?? "[]");
  } catch {
    /* empty */
  }
  return (
    <NewTaskForm
      projects={projects}
      models={models}
      defaultModel={settings.defaultModel ?? "claude-fable-5"}
      dependencyCandidates={recentTasks}
      initialProjectId={projects.some((p) => p.id === project) ? project : undefined}
    />
  );
}
