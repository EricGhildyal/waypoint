"use client";

import { Heading } from "@/components/catalyst";
import type { TaskListResponse } from "@/lib/task-list";
import { TaskBoard } from "./task-board";

export function Dashboard({
  initial,
  projects,
}: {
  initial: TaskListResponse;
  projects: Array<{ id: string; name: string }>;
}) {
  return <TaskBoard initial={initial} projects={projects} header={<Heading>Dashboard</Heading>} />;
}
