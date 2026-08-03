"use client";

import clsx from "clsx";
import { useFormik } from "formik";
import { useState } from "react";
import { useSWRConfig } from "swr";
import * as Yup from "yup";
import { Badge, Button, ButtonGroup, Card, Textarea } from "@/components/catalyst";
import { ErrorText, fieldError } from "@/components/form-utils";
import { apiFetch, formatTime } from "@/lib/format";
import type { QuestionView } from "@/lib/task-detail";
import { FocusAnchor } from "./focus-anchor";

const AnswerSchema = Yup.object({
  answer: Yup.string().trim().required("Write an answer first"),
});

export function QuestionCard({
  taskId,
  question,
  highlighted,
}: {
  taskId: string;
  question: QuestionView;
  highlighted: boolean;
}) {
  const { mutate } = useSWRConfig();
  const [busy, setBusy] = useState(false);

  async function send(text: string) {
    await apiFetch(`/api/tasks/${taskId}/questions/${question.id}/answer`, {
      method: "POST",
      body: JSON.stringify({ answer: text }),
    });
    await mutate(`/api/tasks/${taskId}`);
  }

  const formik = useFormik({
    initialValues: { answer: "" },
    validationSchema: AnswerSchema,
    onSubmit: async (values, helpers) => {
      try {
        await send(values.answer.trim());
        helpers.resetForm();
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err));
      } finally {
        helpers.setSubmitting(false);
      }
    },
  });

  /** one-click multiple-choice options bypass the free-text form */
  async function submitOption(text: string) {
    setBusy(true);
    try {
      await send(text);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FocusAnchor highlighted={highlighted}>
      <Card className={clsx("space-y-2", question.status === "OPEN" && "border-amber-900/50")}>
        <div className="flex items-center justify-between gap-2">
          <Badge color={question.status === "OPEN" ? "amber" : "green"}>
            {question.kind === "PLAN_APPROVAL" ? "Plan approval" : "Question"} ·{" "}
            {question.status.toLowerCase()}
          </Badge>
          <span className="text-xs text-zinc-500">{formatTime(question.createdAt)}</span>
        </div>
        <p className="whitespace-pre-wrap text-sm text-zinc-200">{question.text}</p>
        {question.contextSummary && question.contextSummary !== question.text ? (
          <p className="text-xs text-zinc-500">{question.contextSummary}</p>
        ) : null}
        {question.status === "OPEN" ? (
          <div className="space-y-2 pt-1">
            {question.options?.length ? (
              // a small set of mutually exclusive answers reads best as a
              // segmented group ("Yes | No"); longer lists stay as loose buttons
              question.options.length <= 3 ? (
                <ButtonGroup
                  full
                  aria-label="Answer options"
                  options={question.options.map((opt) => ({ value: opt, label: opt }))}
                  onChange={(opt) => void submitOption(opt)}
                  disabled={busy || formik.isSubmitting}
                />
              ) : (
                <div className="flex flex-wrap gap-2">
                  {question.options.map((opt) => (
                    <Button
                      key={opt}
                      small
                      type="button"
                      variant="outline"
                      disabled={busy || formik.isSubmitting}
                      onClick={() => void submitOption(opt)}
                    >
                      {opt}
                    </Button>
                  ))}
                </div>
              )
            ) : null}
            <form onSubmit={formik.handleSubmit} noValidate>
              <div className="space-y-2">
                <Textarea rows={2} placeholder="Answer…" {...formik.getFieldProps("answer")} />
                <Button
                  className="w-full"
                  type="submit"
                  variant="primary"
                  disabled={busy}
                  loading={formik.isSubmitting}
                >
                  Send
                </Button>
              </div>
              <ErrorText>{fieldError(formik, "answer")}</ErrorText>
            </form>
          </div>
        ) : (
          <p className="rounded-lg bg-zinc-900 p-2 text-sm text-zinc-300">
            <span className="text-xs text-zinc-500">
              Answered via {question.answeredVia?.toLowerCase() ?? "?"}:{" "}
            </span>
            {question.answer}
          </p>
        )}
      </Card>
    </FocusAnchor>
  );
}
