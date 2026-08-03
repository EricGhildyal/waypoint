import { db, openSecret } from "@waypoint/core";

/** Decrypted project secrets (env-var map) for container injection. */
export async function projectSecretEnv(projectId: string): Promise<Record<string, string>> {
  const rows = await db.secret.findMany({ where: { projectId } });
  const out: Record<string, string> = {};
  for (const row of rows) {
    try {
      out[row.key] = openSecret(row.ciphertext);
    } catch {
      console.warn(`[secrets] failed to open secret ${row.key} for project ${projectId}`);
    }
  }
  return out;
}

/** Global secret (projectId null), decrypted — e.g. CLAUDE_CODE_OAUTH_TOKEN, GIT_PAT. */
export async function globalSecret(key: string): Promise<string | null> {
  const row = await db.secret.findFirst({ where: { projectId: null, key } });
  if (!row) return null;
  try {
    return openSecret(row.ciphertext);
  } catch {
    console.warn(`[secrets] failed to open global secret ${key}`);
    return null;
  }
}

/** Per-project GIT_PAT with global fallback (§1 git output). */
export async function gitPatFor(projectId: string): Promise<string | null> {
  const projectRows = await projectSecretEnv(projectId);
  return projectRows.GIT_PAT ?? (await globalSecret("GIT_PAT"));
}
