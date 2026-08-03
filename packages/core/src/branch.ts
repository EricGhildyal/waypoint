/** Render a project's branchTemplate. Placeholders: {id} {slug} {difficulty} {project}. */
export function renderBranchTemplate(
  template: string,
  vars: { id: string; title: string; difficulty: string; project: string },
): string {
  return template
    .replaceAll("{id}", vars.id)
    .replaceAll("{slug}", slugify(vars.title))
    .replaceAll("{difficulty}", vars.difficulty.toLowerCase())
    .replaceAll("{project}", slugify(vars.project));
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "task"
  );
}
