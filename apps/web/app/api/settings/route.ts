import { type NextRequest, NextResponse } from "next/server";
import { SETTING_DEFAULTS, db, getAllSettings, setSetting } from "@waypoint/core";
import { z } from "zod";
import { ApiError, apiError, assertSameOrigin, requireUser } from "@/lib/api";
import { putSecret } from "@/lib/secrets";

export async function GET() {
  try {
    await requireUser();
    const [settings, allowedEmails, claudeToken, gitPat, botPat] = await Promise.all([
      getAllSettings(),
      db.allowedEmail.findMany({ orderBy: { email: "asc" } }),
      db.secret.findFirst({ where: { projectId: null, key: "CLAUDE_CODE_OAUTH_TOKEN" } }),
      db.secret.findFirst({ where: { projectId: null, key: "GIT_PAT" } }),
      db.secret.findFirst({ where: { projectId: null, key: "GIT_BOT_PAT" } }),
    ]);
    let models: string[] = [];
    try {
      models = JSON.parse(settings.models ?? "[]");
    } catch {
      /* keep empty */
    }
    return NextResponse.json({
      settings,
      models,
      allowedEmails: allowedEmails.map((e) => e.email),
      claudeTokenSet: Boolean(claudeToken),
      githubPatSet: Boolean(gitPat),
      githubBotPatSet: Boolean(botPat),
    });
  } catch (err) {
    return apiError(err);
  }
}

const positive = (value: string) => value.trim() !== "" && Number(value) > 0;
const positiveInt = (value: string) => positive(value) && Number.isInteger(Number(value));
const yesNo = (value: string) => value === "true" || value === "false";

/**
 * Values the orchestrator acts on blindly. A blank or zero here does real
 * damage: zero parallel tasks stops everything, a zero memory limit means no
 * limit at all, a mistyped login means no PR comment is ever acted on.
 */
const SETTING_RULES: Record<string, (value: string) => boolean> = {
  maxParallelTasks: positiveInt,
  containerMemGb: positive,
  containerCpus: positive,
  notifyOnDone: yesNo,
  notifyOnNeedsInput: yesNo,
  notifyOnFailed: yesNo,
  autoApproveEasyPlans: yesNo,
  prMergeMethod: (value) => ["merge", "squash", "rebase"].includes(value),
  prTrustedLogins: (value) =>
    value
      .split(",")
      .map((login) => login.trim())
      .filter(Boolean)
      .every((login) => /^[a-z\d](?:[a-z\d-]{0,38})$/i.test(login)),
};

const PatchSchema = z.object({
  settings: z.record(z.string(), z.string()).optional(),
  addEmail: z.string().email().optional(),
  removeEmail: z.string().email().optional(),
  // write-only rotations (§9): stored as encrypted global Secrets; new and
  // recreated containers pick up the latest value.
  claudeOauthToken: z.string().optional(),
  githubPat: z.string().optional(),
  githubBotPat: z.string().optional(),
  // only the optional credential can be removed; the others are required to run
  removeSecret: z.literal("githubBotPat").optional(),
});

export async function PATCH(req: NextRequest) {
  try {
    assertSameOrigin(req);
    const user = await requireUser();
    const body = PatchSchema.parse(await req.json());

    if (body.settings) {
      for (const [key, value] of Object.entries(body.settings)) {
        if (!Object.hasOwn(SETTING_DEFAULTS, key)) {
          throw new ApiError(400, `unknown setting: ${key}`);
        }
        const check = SETTING_RULES[key];
        if (check && !check(value)) throw new ApiError(400, `invalid value for ${key}`);
        await setSetting(key, value.trim());
      }
    }
    if (body.addEmail) {
      const email = body.addEmail.toLowerCase();
      await db.allowedEmail.upsert({ where: { email }, update: {}, create: { email } });
    }
    if (body.removeEmail) {
      const email = body.removeEmail.toLowerCase();
      if (email === user.email.toLowerCase()) {
        throw new ApiError(400, "cannot remove your own email");
      }
      await db.allowedEmail.deleteMany({ where: { email } });
    }
    if (body.claudeOauthToken) {
      await putSecret(null, "CLAUDE_CODE_OAUTH_TOKEN", body.claudeOauthToken);
    }
    if (body.githubPat) {
      await putSecret(null, "GIT_PAT", body.githubPat);
    }
    if (body.githubBotPat) {
      await putSecret(null, "GIT_BOT_PAT", body.githubBotPat);
    }
    if (body.removeSecret === "githubBotPat") {
      await db.secret.deleteMany({ where: { projectId: null, key: "GIT_BOT_PAT" } });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
