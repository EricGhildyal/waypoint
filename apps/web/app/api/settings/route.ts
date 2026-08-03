import { type NextRequest, NextResponse } from "next/server";
import { SETTING_DEFAULTS, db, getAllSettings, setSetting } from "@waypoint/core";
import { z } from "zod";
import { ApiError, apiError, assertSameOrigin, requireUser } from "@/lib/api";
import { putSecret } from "@/lib/secrets";

export async function GET() {
  try {
    await requireUser();
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
      /* keep empty */
    }
    return NextResponse.json({
      settings,
      models,
      allowedEmails: allowedEmails.map((e) => e.email),
      claudeTokenSet: Boolean(claudeToken),
      githubPatSet: Boolean(gitPat),
    });
  } catch (err) {
    return apiError(err);
  }
}

const PatchSchema = z.object({
  settings: z.record(z.string(), z.string()).optional(),
  addEmail: z.string().email().optional(),
  removeEmail: z.string().email().optional(),
  // write-only rotations (§9): stored as encrypted global Secrets; new and
  // recreated containers pick up the latest value.
  claudeOauthToken: z.string().optional(),
  githubPat: z.string().optional(),
});

export async function PATCH(req: NextRequest) {
  try {
    assertSameOrigin(req);
    const user = await requireUser();
    const body = PatchSchema.parse(await req.json());

    if (body.settings) {
      for (const [key, value] of Object.entries(body.settings)) {
        if (!(key in SETTING_DEFAULTS)) throw new ApiError(400, `unknown setting: ${key}`);
        await setSetting(key, value);
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
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
