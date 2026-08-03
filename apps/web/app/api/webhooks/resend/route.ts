import { type NextRequest, NextResponse } from "next/server";
import { db } from "@waypoint/core";
import EmailReplyParser from "email-reply-parser";
import { Webhook } from "svix";
import { applyAnswer } from "@/lib/answers";

/**
 * Resend inbound webhook (§8) — reply-by-email.
 *
 * Order matters (§11 inbound email gate): Svix signature first, then the
 * SPF/DKIM-authenticated From address is checked against AllowedEmail. Mail
 * from any non-allowlisted sender is discarded on the spot: not parsed, not
 * recorded, no agent work, nothing. Only then is the q-{questionId}@ recipient
 * resolved and the visible reply text recorded as the answer.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return new NextResponse(null, { status: 500 });

  const payloadText = await req.text();
  let event: ResendInboundEvent;
  try {
    const webhook = new Webhook(secret);
    event = webhook.verify(payloadText, {
      "svix-id": req.headers.get("svix-id") ?? "",
      "svix-timestamp": req.headers.get("svix-timestamp") ?? "",
      "svix-signature": req.headers.get("svix-signature") ?? "",
    }) as ResendInboundEvent;
  } catch {
    return new NextResponse(null, { status: 401 });
  }

  // Only inbound email events are relevant.
  if (!event.type?.endsWith("email.received")) return NextResponse.json({ ok: true });
  const data = event.data ?? {};

  // 1) Authenticated-sender gate. Use SPF/DKIM results when Resend provides
  //    them — a failed authentication means the From header is not trustworthy.
  const spf = (data.spf?.result ?? data.spf_result ?? "").toLowerCase();
  const dkim = (data.dkim?.result ?? data.dkim_result ?? "").toLowerCase();
  if ((spf && spf !== "pass") || (dkim && dkim !== "pass")) {
    return NextResponse.json({ ok: true }); // discard, no side effects
  }

  const from = extractEmail(typeof data.from === "string" ? data.from : (data.from?.email ?? ""));
  if (!from) return NextResponse.json({ ok: true });
  const allowed = await db.allowedEmail.findUnique({ where: { email: from } });
  if (!allowed) {
    return NextResponse.json({ ok: true }); // discarded before any parsing
  }

  // 2) Resolve q-{questionId}@INBOUND_DOMAIN among the recipients.
  const domain = (process.env.INBOUND_DOMAIN ?? "").toLowerCase();
  const recipients = (Array.isArray(data.to) ? data.to : [data.to])
    .map((t) => extractEmail(typeof t === "string" ? t : (t?.email ?? "")))
    .filter((t): t is string => Boolean(t));
  let questionId: string | null = null;
  for (const rcpt of recipients) {
    const match = /^q-([0-9a-f-]{36})@(.+)$/i.exec(rcpt);
    const qid = match?.[1];
    const rcptDomain = match?.[2];
    if (qid && (!domain || rcptDomain?.toLowerCase() === domain)) {
      questionId = qid;
      break;
    }
  }
  if (!questionId) {
    console.warn(`[security-audit] allowlisted inbound mail from ${from} to unmatched recipient`);
    return NextResponse.json({ ok: true });
  }

  const question = await db.question.findUnique({ where: { id: questionId } });
  if (!question || question.status !== "OPEN") {
    console.warn(`[security-audit] inbound mail from ${from} for unknown/closed question`);
    return NextResponse.json({ ok: true });
  }

  // 3) Strip quoted reply text and record the answer.
  const rawBody = data.text ?? stripHtml(data.html ?? "");
  const visible = new EmailReplyParser().read(rawBody).getVisibleText().trim();
  if (!visible) return NextResponse.json({ ok: true });

  try {
    await applyAnswer(question.taskId, question.id, visible, "EMAIL");
  } catch (err) {
    console.warn(`[webhook] failed to apply email answer: ${String(err)}`);
  }
  return NextResponse.json({ ok: true });
}

interface ResendInboundEvent {
  type?: string;
  data?: {
    from?: string | { email?: string };
    to?: Array<string | { email?: string }> | string | { email?: string };
    subject?: string;
    text?: string;
    html?: string;
    spf?: { result?: string };
    dkim?: { result?: string };
    spf_result?: string;
    dkim_result?: string;
  };
}

function extractEmail(value: string): string | null {
  const angled = /<([^>]+)>/.exec(value);
  const email = (angled?.[1] ?? value).trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+$/.test(email) ? email : null;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+\n/g, "\n")
    .trim();
}
