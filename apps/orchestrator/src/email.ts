import { randomUUID } from "node:crypto";
import { Resend } from "resend";
import { db, emitEvent, getSetting } from "@waypoint/core";
import type { FindingApprovalItem, Question, Task } from "@waypoint/core";
import { env } from "./env";

/**
 * Email dispatch (§8) — the orchestrator owns all outbound mail. Emails carry
 * high-level context + a deeplink only, never transcripts.
 *
 * Exactly-once without schema additions:
 *  - question emails use Question.emailMessageId as the sent marker
 *  - status emails (DONE / FAILED / BUDGET_EXCEEDED) key off their
 *    STATUS_CHANGE event id, recorded as an `email-sent:{eventId}` LOG event
 */
const resend = env.resendApiKey ? new Resend(env.resendApiKey) : null;

export async function dispatchEmails(): Promise<void> {
  if (!resend) return;
  // deeplinks use the editable Settings appUrl (§9), falling back to the env
  const appUrl = (await getSetting("appUrl")) || env.appUrl;
  await sendQuestionEmails(appUrl);
  await sendStatusEmails(appUrl);
}

/** Prior outbound Message-ID for a task — set In-Reply-To so Gmail threads (§8). */
async function threadHeaders(taskId: string): Promise<Record<string, string>> {
  const prior = await db.question.findFirst({
    where: { taskId, emailMessageId: { not: null } },
    orderBy: { createdAt: "desc" },
  });
  if (!prior?.emailMessageId) return {};
  return { "In-Reply-To": prior.emailMessageId, References: prior.emailMessageId };
}

async function sendQuestionEmails(appUrl: string): Promise<void> {
  if (!(await flag("notifyOnNeedsInput"))) return;
  const questions = await db.question.findMany({
    where: { status: "OPEN", emailMessageId: null },
    include: { task: true },
    take: 10,
  });
  for (const q of questions) {
    const link = `${appUrl}/tasks/${q.taskId}?focus=${q.kind === "PLAN_APPROVAL" ? "plan" : `question-${q.id}`}`;
    const messageId = `<q-${q.id}.${randomUUID()}@${env.inboundDomain}>`;
    const mail = questionMail(q, link);

    const ok = await send({
      subject: `[Waypoint] ${q.task.title}: ${mail.subject}`,
      html: emailHtml(q.task.title, mail.body, link, mail.cta, mail.footer),
      replyTo: `q-${q.id}@${env.inboundDomain}`,
      headers: { "Message-ID": messageId, ...(await threadHeaders(q.taskId)) },
    });
    if (ok) {
      await db.question.update({ where: { id: q.id }, data: { emailMessageId: messageId } });
    }
  }
}

interface QuestionMail {
  subject: string;
  /** pre-rendered, already-escaped HTML */
  body: string;
  cta: string;
  footer?: string;
}

function questionMail(q: Question, link: string): QuestionMail {
  if (q.kind === "PLAN_APPROVAL") {
    return { subject: "plan ready for approval", body: block(planOverview(q)), cta: "Review plan" };
  }
  if (q.kind === "FINDINGS_APPROVAL") {
    const items = (q.items as FindingApprovalItem[] | null) ?? [];
    const gated = items.filter((i) => !i.auto);
    return {
      subject: `${gated.length} review finding${gated.length === 1 ? "" : "s"} need${gated.length === 1 ? "s" : ""} your approval`,
      body: findingsList(items, link),
      cta: "Open the review checklist",
      footer:
        'Or reply to this email with the numbers you want fixed (e.g. "1, 3") — reply "none" to skip them all.',
    };
  }
  return { subject: "input needed", body: block(q.contextSummary), cta: "Answer" };
}

/** Plan emails carry the first section of plan.md only (§8). */
function planOverview(q: Question): string {
  const text = q.text;
  const secondHeading = text.indexOf("\n## ", text.indexOf("## ") + 1);
  const overview = secondHeading > 0 ? text.slice(0, secondHeading) : text;
  return overview.length > 2000 ? `${overview.slice(0, 2000)}…` : overview;
}

const SEVERITY_COLORS: Record<string, string> = {
  high: "#b91c1c",
  medium: "#b45309",
  low: "#52525b",
};

/**
 * The review gate list (§8): every finding needing a yes/no, numbered so a
 * reply-by-email answer can name them, each row linking back to the checklist
 * where the actual checkboxes live.
 */
function findingsList(items: FindingApprovalItem[], link: string): string {
  const gated = items.filter((i) => !i.auto);
  const auto = items.filter((i) => i.auto);

  const rows = gated
    .map(
      (f) => `<tr>
    <td style="padding:10px 10px 10px 0;vertical-align:top;font-size:13px;font-weight:600;color:#71717a;white-space:nowrap">${f.number}.</td>
    <td style="padding:10px 0;vertical-align:top;border-bottom:1px solid #e4e4e7">
      <div style="font-size:12px;color:${SEVERITY_COLORS[f.severity ?? "low"] ?? "#52525b"}">
        ${escapeHtml(f.severity ?? "finding")} · ${escapeHtml(f.category)} · <code style="color:#52525b">${escapeHtml(f.file)}</code>
      </div>
      <div style="font-size:14px;line-height:1.5;margin-top:3px">${escapeHtml(f.description)}</div>
      ${f.suggestion ? `<div style="font-size:12px;color:#71717a;margin-top:3px">💡 ${escapeHtml(f.suggestion)}</div>` : ""}
    </td>
  </tr>`,
    )
    .join("");

  const autoBlock = auto.length
    ? `<p style="font-size:13px;color:#71717a;margin:16px 0 0">
    Also fixed automatically, no approval needed (${auto.length} readability/simplification finding${auto.length === 1 ? "" : "s"}):
  </p>
  <ul style="font-size:13px;color:#71717a;line-height:1.6;margin:4px 0 0;padding-left:18px">
    ${auto.map((f) => `<li><code>${escapeHtml(f.file)}</code> — ${escapeHtml(f.description)}</li>`).join("")}
  </ul>`
    : "";

  return `<p style="font-size:14px;line-height:1.6;margin:0 0 4px">
    The code review found ${gated.length} issue${gated.length === 1 ? "" : "s"} that need your call.
    <a href="${link}" style="color:#4f46e5">Tick the ones you want fixed</a> — anything you leave unchecked is dropped.
  </p>
  <table style="width:100%;border-collapse:collapse">${rows}</table>
  ${autoBlock}`;
}

/** The grey pre-wrap panel used for plain-text email bodies. */
function block(text: string): string {
  return `<div style="font-size:14px;line-height:1.6;white-space:pre-wrap;background:#f4f4f5;border-radius:10px;padding:14px 16px">${escapeHtml(text)}</div>`;
}

async function sendStatusEmails(appUrl: string): Promise<void> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const changes = await db.event.findMany({
    where: { type: "STATUS_CHANGE", createdAt: { gt: since } },
    orderBy: { createdAt: "asc" },
    include: { task: true },
  });
  const interesting = changes.filter((c) => {
    const to = (c.payload as { to?: string }).to;
    return to === "DONE" || to === "FAILED" || to === "PAUSED";
  });
  if (interesting.length === 0) return;

  const markers = await db.event.findMany({
    where: { type: "LOG", createdAt: { gt: since } },
  });
  const sent = new Set(
    markers
      .map((m) => (m.payload as { line?: string }).line ?? "")
      .filter((l) => l.startsWith("email-sent:"))
      .map((l) => l.slice("email-sent:".length)),
  );

  for (const change of interesting) {
    if (sent.has(change.id)) continue;
    const to = (change.payload as { to?: string; reason?: string }).to;
    const task = change.task;
    let ok = false;

    if (to === "DONE" && (await flag("notifyOnDone"))) {
      ok = await send({
        subject: `[Waypoint] ${task.title}: done`,
        html: emailHtml(
          task.title,
          block(task.prUrl ? `PR opened: ${task.prUrl}` : "Task completed."),
          task.prUrl ?? `${appUrl}/tasks/${task.id}`,
          task.prUrl ? "Open PR" : "Open task",
        ),
        headers: await threadHeaders(task.id),
      });
    } else if (to === "FAILED" && (await flag("notifyOnFailed"))) {
      ok = await send({
        subject: `[Waypoint] ${task.title}: failed`,
        html: emailHtml(
          task.title,
          block(
            `${task.failureCode ?? "FAILURE"}: ${task.failureDetail ?? "see the activity log"}`,
          ),
          `${appUrl}/tasks/${task.id}`,
          "Inspect & retry",
        ),
        headers: await threadHeaders(task.id),
      });
    } else if (to === "PAUSED" && task.pauseReason === "BUDGET_EXCEEDED") {
      ok = await send({
        subject: `[Waypoint] ${task.title}: token budget exceeded`,
        html: emailHtml(
          task.title,
          block("The task hit its token budget and was paused."),
          `${appUrl}/tasks/${task.id}`,
          "Review & resume",
        ),
        headers: await threadHeaders(task.id),
      });
    } else {
      // not an email-worthy change (or notifications off) — mark handled
      ok = true;
    }

    if (ok) {
      await emitEvent(task.id, "LOG", { level: "debug", line: `email-sent:${change.id}` });
    }
  }
}

async function recipients(): Promise<string[]> {
  const rows = await db.allowedEmail.findMany();
  return rows.map((r) => r.email).filter((e) => !e.endsWith("@waypoint.local"));
}

async function send(opts: {
  subject: string;
  html: string;
  replyTo?: string;
  headers?: Record<string, string>;
}): Promise<boolean> {
  if (!resend) return false;
  const to = await recipients();
  if (to.length === 0) return true;
  try {
    const res = await resend.emails.send({
      from: `Waypoint <${env.emailFrom}>`,
      to,
      subject: opts.subject,
      html: opts.html,
      ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
      ...(opts.headers ? { headers: opts.headers } : {}),
    });
    if (res.error) {
      console.warn(`[email] send failed: ${res.error.message}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[email] send failed: ${String(err)}`);
    return false;
  }
}

/** `bodyHtml` is pre-rendered and already escaped — see block() / findingsList(). */
function emailHtml(
  title: string,
  bodyHtml: string,
  link: string,
  cta: string,
  footer = "Reply to this email to answer directly.",
): string {
  return `<!doctype html>
<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#18181b">
  <p style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#71717a;margin:0 0 8px">Waypoint</p>
  <h2 style="font-size:17px;margin:0 0 12px">${escapeHtml(title)}</h2>
  ${bodyHtml}
  <p style="margin:18px 0">
    <a href="${link}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;border-radius:8px;padding:9px 16px;font-size:14px;font-weight:500">${escapeHtml(cta)}</a>
  </p>
  <p style="font-size:12px;color:#a1a1aa;margin:0">${escapeHtml(footer)}</p>
</div>`;
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

async function flag(key: string): Promise<boolean> {
  return (await getSetting(key)) !== "false";
}

/** Task type re-export helper for callers */
export type { Task };
