"use client";

import { useFormik } from "formik";
import { useRouter } from "next/navigation";
import { useState } from "react";
import * as Yup from "yup";
import {
  Button,
  ButtonGroup,
  Card,
  Checkbox,
  Field,
  Heading,
  Input,
  Select,
  Textarea,
} from "@/components/catalyst";
import { ErrorText, fieldError } from "@/components/form-utils";
import { apiFetch, STATUS_LABELS } from "@/lib/format";

const DIFFICULTIES = ["EASY", "MEDIUM", "HARD"] as const;
const STAGES = ["planning", "implementation", "review", "testing"] as const;

const DIFFICULTY_OPTIONS = DIFFICULTIES.map((d) => ({
  value: d,
  label: d.charAt(0) + d.slice(1).toLowerCase(),
}));

interface NewTaskValues {
  projectId: string;
  title: string;
  prompt: string;
  difficulty: (typeof DIFFICULTIES)[number];
  models: Record<(typeof STAGES)[number], string>;
  skipTesting: boolean;
  schedule: "now" | "later" | "after";
  scheduledAt: string;
  dependsOnTaskId: string;
  tokenBudget: string;
}

const NewTaskSchema = Yup.object({
  projectId: Yup.string().required("Pick a project"),
  title: Yup.string().trim().max(200, "Keep it under 200 characters").required("Title is required"),
  prompt: Yup.string().trim().required("Prompt is required"),
  difficulty: Yup.string()
    .oneOf([...DIFFICULTIES])
    .required(),
  models: Yup.object({
    planning: Yup.string().required("Required"),
    implementation: Yup.string().required("Required"),
    review: Yup.string().required("Required"),
    testing: Yup.string().required("Required"),
  }),
  skipTesting: Yup.boolean(),
  schedule: Yup.string().oneOf(["now", "later", "after"]).required(),
  scheduledAt: Yup.string().when("schedule", {
    is: "later",
    then: (schema) => schema.required("Pick a date & time"),
  }),
  dependsOnTaskId: Yup.string().when("schedule", {
    is: "after",
    then: (schema) => schema.required("Pick the task to run after"),
  }),
  tokenBudget: Yup.number()
    .transform((value, original) => (original === "" ? undefined : value))
    .typeError("Must be a number")
    .integer("Whole tokens only")
    .positive("Must be positive")
    .notRequired(),
});

export function NewTaskForm({
  projects,
  models,
  defaultModel,
  dependencyCandidates,
  initialProjectId,
}: {
  projects: Array<{ id: string; name: string }>;
  models: string[];
  defaultModel: string;
  dependencyCandidates: Array<{ id: string; title: string; status: string }>;
  initialProjectId?: string;
}) {
  const router = useRouter();
  const [showModels, setShowModels] = useState(false);
  const modelOptions = models.length ? models : [defaultModel];

  const formik = useFormik<NewTaskValues>({
    initialValues: {
      projectId: initialProjectId ?? projects[0]?.id ?? "",
      title: "",
      prompt: "",
      difficulty: "MEDIUM",
      models: {
        planning: defaultModel,
        implementation: defaultModel,
        review: defaultModel,
        testing: defaultModel,
      },
      skipTesting: false,
      schedule: "now",
      scheduledAt: "",
      dependsOnTaskId: "",
      tokenBudget: "",
    },
    validationSchema: NewTaskSchema,
    onSubmit: async (values, helpers) => {
      helpers.setStatus(undefined);
      try {
        const { id } = await apiFetch<{ id: string }>("/api/tasks", {
          method: "POST",
          body: JSON.stringify({
            projectId: values.projectId,
            title: values.title.trim(),
            prompt: values.prompt.trim(),
            difficulty: values.difficulty,
            models: values.models,
            skipTesting: values.skipTesting,
            scheduledAt:
              values.schedule === "later" && values.scheduledAt
                ? new Date(values.scheduledAt).toISOString()
                : null,
            dependsOnTaskId:
              values.schedule === "after" && values.dependsOnTaskId ? values.dependsOnTaskId : null,
            tokenBudget: values.tokenBudget ? Number(values.tokenBudget) : null,
          }),
        });
        router.push(`/tasks/${id}`);
      } catch (err) {
        helpers.setStatus(err instanceof Error ? err.message : String(err));
        helpers.setSubmitting(false);
      }
    },
  });

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Heading>New Task</Heading>
      <form onSubmit={formik.handleSubmit} noValidate>
        <Card className="space-y-4">
          <Field label="Project">
            <Select {...formik.getFieldProps("projectId")}>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
            <ErrorText>{fieldError(formik, "projectId")}</ErrorText>
          </Field>
          <Field label="Title">
            <Input
              placeholder="Add CSV export to the reports page"
              {...formik.getFieldProps("title")}
            />
            <ErrorText>{fieldError(formik, "title")}</ErrorText>
          </Field>
          <Field
            label="Prompt"
            hint="What should the agent build? Be specific about intent and scope."
          >
            <Textarea
              rows={6}
              placeholder="Describe the change…"
              {...formik.getFieldProps("prompt")}
            />
            <ErrorText>{fieldError(formik, "prompt")}</ErrorText>
          </Field>
          <Field
            label="Difficulty"
            hint="Affects planning depth only — every plan still needs your approval."
          >
            <ButtonGroup
              full
              options={DIFFICULTY_OPTIONS}
              value={formik.values.difficulty}
              onChange={(d) => formik.setFieldValue("difficulty", d)}
            />
          </Field>

          <label htmlFor="skip-testing" className="flex cursor-pointer gap-3">
            <Checkbox
              id="skip-testing"
              className="mt-0.5"
              checked={formik.values.skipTesting}
              onChange={(e) => formik.setFieldValue("skipTesting", e.target.checked)}
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-zinc-200">Skip browser testing</span>
              <span className="mt-0.5 block text-xs text-zinc-500">
                For changes with no UI. Skips the browser (Playwright) testing stage — the
                project&apos;s test suite and coverage gate still run.
              </span>
            </span>
          </label>

          <div>
            <button
              type="button"
              onClick={() => setShowModels((v) => !v)}
              className="text-xs font-medium text-zinc-400 hover:text-zinc-200 cursor-pointer"
            >
              {showModels ? "▾" : "▸"} Models
            </button>
            {showModels ? (
              <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
                {STAGES.filter((stage) => stage !== "testing" || !formik.values.skipTesting).map(
                  (stage) => (
                    <Field key={stage} label={stage.charAt(0).toUpperCase() + stage.slice(1)}>
                      <Select {...formik.getFieldProps(`models.${stage}`)}>
                        {modelOptions.map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </Select>
                      <ErrorText>{fieldError(formik, `models.${stage}`)}</ErrorText>
                    </Field>
                  ),
                )}
              </div>
            ) : null}
          </div>

          <Field label="Schedule">
            <div className="space-y-2">
              <Select {...formik.getFieldProps("schedule")}>
                <option value="now">Run now</option>
                <option value="later">At a specific time</option>
                <option value="after">After another task</option>
              </Select>
              {formik.values.schedule === "later" ? (
                <>
                  <Input type="datetime-local" {...formik.getFieldProps("scheduledAt")} />
                  <ErrorText>{fieldError(formik, "scheduledAt")}</ErrorText>
                </>
              ) : null}
              {formik.values.schedule === "after" ? (
                <>
                  <Select {...formik.getFieldProps("dependsOnTaskId")}>
                    <option value="">Select task…</option>
                    {dependencyCandidates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {`${t.title} (${STATUS_LABELS[t.status] ?? t.status})`}
                      </option>
                    ))}
                  </Select>
                  <ErrorText>{fieldError(formik, "dependsOnTaskId")}</ErrorText>
                </>
              ) : null}
            </div>
          </Field>

          <Field
            label="Token budget (optional)"
            hint="Total tokens across all stages; the task pauses when exceeded."
          >
            <Input
              type="number"
              min={1}
              placeholder="e.g. 2000000"
              {...formik.getFieldProps("tokenBudget")}
            />
            <ErrorText>{fieldError(formik, "tokenBudget")}</ErrorText>
          </Field>

          {formik.status ? <p className="text-sm text-red-400">{formik.status}</p> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => router.back()}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={formik.isSubmitting}>
              Create task
            </Button>
          </div>
        </Card>
      </form>
    </div>
  );
}
