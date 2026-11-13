import { type NextRequest, NextResponse } from "next/server";
import { db, openSecret } from "@waypoint/core";
import { z } from "zod";
import { ApiError, apiError, assertSameOrigin, requireUser } from "@/lib/api";
import { DETECT_FILES, detectCommands } from "@/lib/detect-commands";

const BodySchema = z.object({
  repoUrl: z.string().url(),
  defaultBranch: z.string().min(1).default("main"),
  /** an existing project, whose own GIT_PAT is tried before the global one */
  projectId: z.string().optional(),
});

/**
 * Read the Makefile, compose file and package.json at the root of a GitHub
 * repository and suggest the project's commands from them, to pre-fill the
 * project form. Nothing is saved.
 */
export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req);
    await requireUser();
    const body = BodySchema.parse(await req.json());
    const repo = githubRepo(body.repoUrl);
    if (!repo) throw new ApiError(422, "Commands can only be detected for github.com repositories");

    const base = `https://api.github.com/repos/${repo}/contents`;
    const ref = `?ref=${encodeURIComponent(body.defaultBranch)}`;

    // The stored tokens can differ in what they reach (a bot account in one
    // organisation, a personal token in another), so try each in turn — and
    // finally none, which is enough for a public repository.
    const tokens = await gitTokens(body.projectId);
    let headers: Record<string, string> = {};
    let listing: Response | undefined;
    for (const token of [...tokens, null]) {
      headers = {
        "X-GitHub-Api-Version": "2022-11-28",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      };
      listing = await fetch(`${base}/${ref}`, {
        headers: { ...headers, Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (![401, 403, 404].includes(listing.status)) break;
    }
    if (!listing || [401, 403, 404].includes(listing.status)) {
      throw new ApiError(
        422,
        tokens.length
          ? `Couldn't read ${repo} at ${body.defaultBranch} — check the URL and branch, and that one of the GitHub tokens (bot or personal) can see the repository`
          : `Couldn't read ${repo} at ${body.defaultBranch} — check the URL and branch. No GitHub token is set, so private repositories can't be read`,
      );
    }
    if (!listing.ok) throw new ApiError(502, `GitHub answered ${listing.status}`);
    const entries = (await listing.json()) as { name: string; type: string }[];
    const rootNames = entries.filter((e) => e.type === "file").map((e) => e.name);

    const files: Record<string, string> = {};
    await Promise.all(
      DETECT_FILES.filter((name) => rootNames.includes(name)).map(async (name) => {
        const res = await fetch(`${base}/${encodeURIComponent(name)}${ref}`, {
          headers: { ...headers, Accept: "application/vnd.github.raw+json" },
          signal: AbortSignal.timeout(15_000),
        });
        if (res.ok) files[name] = (await res.text()).slice(0, 500_000);
      }),
    );

    return NextResponse.json(detectCommands(files, rootNames));
  } catch (err) {
    return apiError(err);
  }
}

/** "owner/repo" from a github.com clone URL, or null. */
function githubRepo(repoUrl: string): string | null {
  try {
    const url = new URL(repoUrl);
    if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return null;
    const [owner, name] = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
    const repo = name?.replace(/\.git$/, "");
    if (!owner || !repo || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
    return `${owner}/${repo}`;
  } catch {
    return null;
  }
}

/** Bot tokens before personal ones, a project's before the global one. */
const rank = (r: { key: string; projectId: string | null }) =>
  (r.key === "GIT_BOT_PAT" ? 0 : 2) + (r.projectId ? 0 : 1);

/**
 * Every stored token that might read the repository, in the order tasks
 * prefer them: the bot's before the personal one, the project's before the
 * global one.
 */
async function gitTokens(projectId: string | undefined): Promise<string[]> {
  const rows = await db.secret.findMany({
    where: {
      key: { in: ["GIT_BOT_PAT", "GIT_PAT"] },
      OR: [{ projectId: null }, ...(projectId ? [{ projectId }] : [])],
    },
  });
  const tokens: string[] = [];
  for (const row of rows.toSorted((a, b) => rank(a) - rank(b))) {
    try {
      tokens.push(openSecret(row.ciphertext));
    } catch {
      /* sealed with a different master key — skip */
    }
  }
  return [...new Set(tokens)];
}
