import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError, assertSameOrigin, requireUser } from "@/lib/api";
import { applyAnswer } from "@/lib/answers";

const BodySchema = z.object({ answer: z.string().min(1) });

/** Also how plans are approved (§10) — send "approve" or revision notes. */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; qid: string }> },
) {
  try {
    assertSameOrigin(req);
    await requireUser();
    const { id, qid } = await ctx.params;
    const { answer } = BodySchema.parse(await req.json());
    await applyAnswer(id, qid, answer, "UI");
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
