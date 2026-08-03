import { notFound } from "next/navigation";
import { db } from "@waypoint/core";
import type { ProjectFormData } from "../project-form";
import { getTaskList } from "@/lib/task-list";
import { ProjectDetail } from "./project-detail";

export const dynamic = "force-dynamic";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [project, initialTasks] = await Promise.all([
    db.project.findUnique({
      where: { id },
      include: { secrets: { select: { key: true } } },
    }),
    getTaskList({ projectId: id }),
  ]);
  if (!project) notFound();

  const data: ProjectFormData = {
    id: project.id,
    name: project.name,
    repoUrl: project.repoUrl,
    defaultBranch: project.defaultBranch,
    branchTemplate: project.branchTemplate,
    setupCommand: project.setupCommand,
    runCommand: project.runCommand,
    runReadyUrl: project.runReadyUrl,
    migrateCommand: project.migrateCommand,
    testCommand: project.testCommand,
    coverageFormat: project.coverageFormat,
    coverageReportPath: project.coverageReportPath,
    lintCommand: project.lintCommand,
    formatCommand: project.formatCommand,
    dockerfilePath: project.dockerfilePath,
    instructions: project.instructions,
    coverageBar: project.coverageBar,
    secrets: project.secrets.map((s) => s.key),
  };

  return <ProjectDetail project={data} initialTasks={initialTasks} />;
}
