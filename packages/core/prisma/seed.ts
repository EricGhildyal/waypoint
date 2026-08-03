/**
 * Idempotent first-boot seed — runs in the web container entrypoint after
 * `prisma migrate deploy` (and can be re-run any time; it never overwrites).
 *
 *  - Setting defaults (defaultModel=claude-fable-5, maxParallelTasks=3, ...)
 *  - AllowedEmail rows from SEED_ALLOWED_EMAILS (comma-separated)
 *  - Global secrets seeded from env on first boot only:
 *      CLAUDE_CODE_OAUTH_TOKEN -> Secret(projectId=null, key=CLAUDE_CODE_OAUTH_TOKEN)
 *      GITHUB_DEFAULT_PAT      -> Secret(projectId=null, key=GIT_PAT)
 *    (thereafter both are managed from Settings as encrypted global Secrets)
 */
import { SETTING_DEFAULTS } from "../src/constants";
import { sealSecret } from "../src/crypto";
import { db } from "../src/db";

async function main() {
  for (const [key, value] of Object.entries(SETTING_DEFAULTS)) {
    await db.setting.upsert({ where: { key }, update: {}, create: { key, value } });
  }

  const emails = (process.env.SEED_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  for (const email of emails) {
    await db.allowedEmail.upsert({ where: { email }, update: {}, create: { email } });
  }

  const globalSecrets: Array<[string, string | undefined]> = [
    ["CLAUDE_CODE_OAUTH_TOKEN", process.env.CLAUDE_CODE_OAUTH_TOKEN],
    ["GIT_PAT", process.env.GITHUB_DEFAULT_PAT],
  ];
  for (const [key, value] of globalSecrets) {
    if (!value) continue;
    const existing = await db.secret.findFirst({ where: { projectId: null, key } });
    if (!existing) {
      await db.secret.create({ data: { projectId: null, key, ciphertext: sealSecret(value) } });
    }
  }

  console.log("[seed] settings, allowlist and global secrets ensured");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
