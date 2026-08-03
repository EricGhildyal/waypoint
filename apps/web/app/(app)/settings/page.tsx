import { db, getAllSettings } from "@waypoint/core";
import { SettingsForm } from "./settings-form";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [settings, allowedEmails, claudeToken, gitPat] = await Promise.all([
    getAllSettings(),
    db.allowedEmail.findMany({ orderBy: { email: "asc" } }),
    db.secret.findFirst({ where: { projectId: null, key: "CLAUDE_CODE_OAUTH_TOKEN" } }),
    db.secret.findFirst({ where: { projectId: null, key: "GIT_PAT" } }),
  ]);
  let models: string[] = [];
  try {
    models = JSON.parse(settings.models ?? "[]");
  } catch {
    /* empty */
  }
  return (
    <SettingsForm
      initialSettings={settings}
      initialModels={models}
      initialEmails={allowedEmails.map((e) => e.email)}
      claudeTokenSet={Boolean(claudeToken)}
      githubPatSet={Boolean(gitPat)}
    />
  );
}
