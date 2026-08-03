import { notFound } from "next/navigation";
import { TaskDetailView } from "../task-detail";
import { getTaskDetail } from "@/lib/task-detail";

export const dynamic = "force-dynamic";

export default async function TaskPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ focus?: string }>;
}) {
  const { id } = await params;
  const { focus } = await searchParams;
  try {
    const initial = await getTaskDetail(id);
    return <TaskDetailView initial={initial} focus={focus ?? null} />;
  } catch {
    notFound();
  }
}
