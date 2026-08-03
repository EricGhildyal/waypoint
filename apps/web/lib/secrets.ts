import { db, sealSecret } from "@waypoint/core";

/**
 * Secret row helpers. Note: SQLite UNIQUE treats NULLs as distinct, so global
 * secrets (projectId = null) are managed via findFirst instead of upsert.
 */
export async function putSecret(
  projectId: string | null,
  key: string,
  value: string,
): Promise<void> {
  const ciphertext = sealSecret(value);
  const existing = await db.secret.findFirst({ where: { projectId, key } });
  if (existing) {
    await db.secret.update({ where: { id: existing.id }, data: { ciphertext } });
  } else {
    await db.secret.create({ data: { projectId, key, ciphertext } });
  }
}

export async function deleteSecret(projectId: string | null, key: string): Promise<void> {
  await db.secret.deleteMany({ where: { projectId, key } });
}
