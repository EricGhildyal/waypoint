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
 *  - The Waypoint project itself, so a fresh dev.db can run tasks on this repo
 *    (created once; edits made in the UI are never clobbered)
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

  // Waypoint works on itself. Fields left off take their schema defaults
  // (defaultBranch=main, branchTemplate, coverage*); testCommand stays null,
  // so there is no test/coverage gate — the repo has no `make test` target.
  await db.project.upsert({
    where: { name: "Waypoint" },
    update: {},
    create: {
      name: "Waypoint",
      repoUrl: "https://github.com/EricGhildyal/waypoint",
      setupCommand: "make setup",
      runCommand: "make run",
      runReadyUrl: "http://localhost:3000/health",
      lintCommand: "make lint-fix",
      formatCommand: "make format",
      instructions: [
        "Waypoint is an internal AI harness that I use to work on client projects",
        "",
        "- Waypoint should be as simple as possible, it should focus on being a solid, predictable harness and try to minimize complexity and over-engineering.",
      ].join("\n"),
    },
  });

  console.log("[seed] settings, allowlist, global secrets and Waypoint project ensured");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
