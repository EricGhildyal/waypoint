import Link from "next/link";
import { db } from "@waypoint/core";
import { Button, EmptyState, Heading } from "@/components/catalyst";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  const projects = await db.project.findMany({
    orderBy: { name: "asc" },
    include: { _count: { select: { tasks: true } } },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Heading>Projects</Heading>
        <Link href="/projects/new">
          <Button variant="primary">New Project</Button>
        </Link>
      </div>
      {projects.length === 0 ? (
        <EmptyState>
          No projects yet.{" "}
          <Link href="/projects/new" className="text-indigo-400 hover:underline">
            Register the first repo
          </Link>
          .
        </EmptyState>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {projects.map((p) => (
            <Link
              key={p.id}
              href={`/projects/${p.id}`}
              className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 transition-colors hover:border-zinc-600"
            >
              <div className="font-medium text-zinc-100">{p.name}</div>
              <div className="mt-0.5 truncate text-xs text-zinc-500">{p.repoUrl}</div>
              <div className="mt-2 text-xs text-zinc-500">
                {p._count.tasks} task{p._count.tasks === 1 ? "" : "s"} · {p.defaultBranch}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
