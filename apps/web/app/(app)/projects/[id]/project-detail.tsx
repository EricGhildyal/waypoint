"use client";

import { useState } from "react";
import { Heading, Tabs } from "@/components/catalyst";
import type { TaskListResponse } from "@/lib/task-list";
import { TaskBoard } from "../../task-board";
import { ProjectForm, type ProjectFormData } from "../project-form";

/** Project page shell: its task board and its settings form, behind tabs. */
export function ProjectDetail({
  project,
  initialTasks,
}: {
  project: ProjectFormData;
  initialTasks: TaskListResponse;
}) {
  const [tab, setTab] = useState("tasks");

  return (
    <div className="space-y-5">
      <Heading>{project.name}</Heading>
      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { key: "tasks", label: "Tasks" },
          { key: "settings", label: "Settings" },
        ]}
      />
      {tab === "tasks" ? (
        <TaskBoard
          initial={initialTasks}
          projectId={project.id}
          newTaskHref={`/tasks/new?project=${project.id}`}
        />
      ) : (
        <ProjectForm existing={project} headerless />
      )}
    </div>
  );
}
