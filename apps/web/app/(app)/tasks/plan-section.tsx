"use client";

import { useFormik } from "formik";
import { useState } from "react";
import { useSWRConfig } from "swr";
import * as Yup from "yup";
import { Button, Card, Disclosure, Subheading, Textarea } from "@/components/catalyst";
import { ErrorText, fieldError } from "@/components/form-utils";
import { Markdown } from "@/components/markdown";
import { apiFetch, formatTime } from "@/lib/format";
import type { QuestionView, TaskDetail } from "@/lib/task-detail";
import { FocusAnchor } from "./focus-anchor";

const RevisionSchema = Yup.object({
  notes: Yup.string().trim().required("Describe the changes you want first"),
});

/**
 * The plan inside the Planning stage row: fully expanded with the approval form
 * while a PLAN_APPROVAL question is open; a collapsed "View plan" disclosure
 * once the plan is approved. Once answered, PlanReply below shows what you
 * replied — the approval or the revision notes that reshaped the plan.
 */
export function PlanSection({ task, focus }: { task: TaskDetail; focus: string | null }) {
  const { mutate } = useSWRConfig();
  const [busy, setBusy] = useState(false);
  // a ?focus=plan deeplink on an already-approved plan opens the disclosure
  const [viewOpen, setViewOpen] = useState(focus === "plan");
  const planQuestion = task.questions.find(
    (q) => q.kind === "PLAN_APPROVAL" && q.status === "OPEN",
  );

  async function answer(text: string) {
    if (!planQuestion) return;
    await apiFetch(`/api/tasks/${task.id}/questions/${planQuestion.id}/answer`, {
      method: "POST",
      body: JSON.stringify({ answer: text }),
    });
    await mutate(`/api/tasks/${task.id}`);
  }

  // "Request changes" submits revision notes; "Approve" bypasses the form
  const formik = useFormik({
    initialValues: { notes: "" },
    validationSchema: RevisionSchema,
    onSubmit: async (values, helpers) => {
      try {
        await answer(values.notes.trim());
        helpers.resetForm();
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err));
      } finally {
        helpers.setSubmitting(false);
      }
    },
  });

  async function approve() {
    setBusy(true);
    try {
      await answer("approve");
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!planQuestion) {
    if (!task.plan) return null;
    return (
      <FocusAnchor highlighted={focus === "plan"}>
        <Disclosure
          open={viewOpen}
          onToggle={() => setViewOpen((v) => !v)}
          header={<span className="text-sm font-medium text-zinc-300">View plan</span>}
          bodyClassName="p-4"
        >
          <Markdown>{task.plan}</Markdown>
        </Disclosure>
      </FocusAnchor>
    );
  }

  return (
    <FocusAnchor highlighted={focus === "plan"}>
      <div className="space-y-4">
        {task.plan ? (
          <Card>
            <Markdown>{task.plan}</Markdown>
          </Card>
        ) : null}
        <Card className="space-y-3 border-purple-900/50">
          <Subheading>Plan approval required</Subheading>
          <form onSubmit={formik.handleSubmit} noValidate className="space-y-3">
            <div>
              <Textarea
                rows={2}
                className="w-full"
                placeholder="Revision notes (sending them resumes planning)…"
                {...formik.getFieldProps("notes")}
              />
              <ErrorText>{fieldError(formik, "notes")}</ErrorText>
            </div>
            <div className="flex gap-2">
              <Button
                className="flex-1"
                type="button"
                variant="primary"
                disabled={formik.isSubmitting}
                loading={busy}
                onClick={() => void approve()}
              >
                Approve plan
              </Button>
              <Button
                className="flex-1"
                type="submit"
                variant="outline"
                disabled={busy}
                loading={formik.isSubmitting}
              >
                Request changes
              </Button>
            </div>
          </form>
        </Card>
      </div>
    </FocusAnchor>
  );
}

/**
 * The answer to a PLAN_APPROVAL question — "approve", or the revision notes that
 * sent planning round another lap. Rendered in green at the bottom of the
 * Planning row that asked, mirroring the answered-question UI.
 */
export function PlanReply({ question }: { question: QuestionView }) {
  if (!question.answer) return null;
  return (
    <div className="rounded-lg border border-green-900/50 bg-green-950/20 p-3">
      <p className="text-xs text-green-400">
        Your reply · via {question.answeredVia?.toLowerCase() ?? "?"} ·{" "}
        {formatTime(question.answeredAt ?? question.createdAt)}
      </p>
      <p className="whitespace-pre-wrap wrap-break-word text-sm text-green-200">
        {question.answer}
      </p>
    </div>
  );
}
