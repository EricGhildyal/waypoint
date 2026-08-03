import { type NextRequest, NextResponse } from "next/server";
import { db } from "@waypoint/core";
import { z } from "zod";
import { ApiError, apiError, assertSameOrigin, requireUser } from "@/lib/api";
import { deleteSecret, putSecret } from "@/lib/secrets";

const BodySchema = z.object({ value: z.string().nullable() });

/** Write-only (§10): PUT sets/rotates, value:null deletes. Values are never echoed. */
export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string; key: string }> }) {
  try {
    assertSameOrigin(req);
    await requireUser();
    const { id, key } = await ctx.params;
    if (!/^[A-Z][A-Z0-9_]*$/i.test(key)) throw new ApiError(400, "invalid secret key");
    const project = await db.project.findUnique({ where: { id } });
    if (!project) throw new ApiError(404, "project not found");

    const { value } = BodySchema.parse(await req.json());
    if (value === null || value === "") {
      await deleteSecret(id, key);
    } else {
      await putSecret(id, key, value);
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
