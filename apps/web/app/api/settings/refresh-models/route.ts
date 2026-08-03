import { type NextRequest, NextResponse } from "next/server";
import { setSetting } from "@waypoint/core";
import { ApiError, apiError, assertSameOrigin, requireUser } from "@/lib/api";

/**
 * Refresh the model list via Anthropic GET /v1/models (§9).
 * MODEL_LOOKUP_ANTHROPIC_API_KEY is used exclusively for this free list
 * endpoint — all agent traffic runs on the Claude Max OAuth token. It is
 * deliberately not named ANTHROPIC_API_KEY: the Claude Code SDK picks that name
 * up from the environment automatically and would bill agent runs to this API
 * key instead of the Max subscription.
 */
export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req);
    await requireUser();
    const apiKey = process.env.MODEL_LOOKUP_ANTHROPIC_API_KEY;
    if (!apiKey) throw new ApiError(400, "MODEL_LOOKUP_ANTHROPIC_API_KEY is not configured");

    const ids: string[] = [];
    let afterId: string | null = null;
    for (let page = 0; page < 10; page++) {
      const url = new URL("https://api.anthropic.com/v1/models");
      url.searchParams.set("limit", "100");
      if (afterId) url.searchParams.set("after_id", afterId);
      const res = await fetch(url, {
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      });
      if (!res.ok) throw new ApiError(502, `Anthropic models API returned ${res.status}`);
      const data = (await res.json()) as {
        data: Array<{ id: string }>;
        has_more: boolean;
        last_id: string | null;
      };
      ids.push(...data.data.map((m) => m.id));
      if (!data.has_more || !data.last_id) break;
      afterId = data.last_id;
    }

    const models = ids.filter((id) => id.startsWith("claude-"));
    await setSetting("models", JSON.stringify(models));
    return NextResponse.json({ models });
  } catch (err) {
    return apiError(err);
  }
}
