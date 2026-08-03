import { db } from "@waypoint/core";
import { Dashboard } from "./dashboard";
import { getTaskList } from "@/lib/task-list";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  // server component renders the initial state; the client island keeps it live (§9)
  const [initial, projects] = await Promise.all([
    getTaskList({}),
    db.project.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  return <Dashboard initial={initial} projects={projects} />;
}
