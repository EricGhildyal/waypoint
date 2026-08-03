"use client";

import clsx from "clsx";
import { useFormik } from "formik";
import { useRouter } from "next/navigation";
import { useState } from "react";
import * as Yup from "yup";
import {
  Badge,
  Button,
  Card,
  Field,
  Heading,
  Input,
  Select,
  Subheading,
  Textarea,
} from "@/components/catalyst";
import { ErrorText, emptyToNull, fieldError, urlOrLocalhost } from "@/components/form-utils";
import { apiFetch } from "@/lib/format";

const COVERAGE_FORMATS = [
  "LCOV",
  "COBERTURA_XML",
  "CLOVER_XML",
  "JACOCO_XML",
  "GO_COVERPROFILE",
] as const;

export interface ProjectFormData {
  id?: string;
  name: string;
  repoUrl: string;
  defaultBranch: string;
  branchTemplate: string;
  setupCommand: string;
  runCommand: string;
  runReadyUrl: string | null;
  migrateCommand: string | null;
  testCommand: string;
  coverageFormat: string;
  coverageReportPath: string;
  lintCommand: string | null;
  formatCommand: string | null;
  dockerfilePath: string | null;
  instructions: string;
  coverageBar: number;
  secrets?: string[];
}

/** Form values keep every optional field as a string; "" persists as null. */
interface ProjectValues {
  name: string;
  repoUrl: string;
  defaultBranch: string;
  branchTemplate: string;
  setupCommand: string;
  runCommand: string;
  runReadyUrl: string;
  migrateCommand: string;
  testCommand: string;
  coverageFormat: string;
  coverageReportPath: string;
  lintCommand: string;
  formatCommand: string;
  dockerfilePath: string;
  instructions: string;
  coverageBar: string;
}

const ProjectSchema = Yup.object({
  name: Yup.string().trim().max(100, "Keep it under 100 characters").required("Name is required"),
  repoUrl: Yup.string().url("Must be a valid https clone URL").required("Repo URL is required"),
  defaultBranch: Yup.string().trim().required("Required"),
  branchTemplate: Yup.string().trim().required("Required"),
  setupCommand: Yup.string().trim().required("Setup command is required"),
  runCommand: Yup.string().trim().required("Run command is required"),
  runReadyUrl: urlOrLocalhost("Must be a URL").nullable().transform(emptyToNull),
  migrateCommand: Yup.string().nullable(),
  testCommand: Yup.string().trim().required("Test command is required"),
  coverageFormat: Yup.string()
    .oneOf([...COVERAGE_FORMATS])
    .required(),
  coverageReportPath: Yup.string().trim().required("Required"),
  lintCommand: Yup.string().nullable(),
  formatCommand: Yup.string().nullable(),
  dockerfilePath: Yup.string().nullable(),
  instructions: Yup.string(),
  coverageBar: Yup.number()
    .typeError("0–100")
    .integer("Whole percent")
    .min(0, "0–100")
    .max(100, "0–100")
    .required("Required"),
});

function toValues(existing?: ProjectFormData): ProjectValues {
  return {
    name: existing?.name ?? "",
    repoUrl: existing?.repoUrl ?? "",
    defaultBranch: existing?.defaultBranch ?? "main",
    branchTemplate: existing?.branchTemplate ?? "eric/{id}",
    setupCommand: existing?.setupCommand ?? "",
    runCommand: existing?.runCommand ?? "",
    runReadyUrl: existing?.runReadyUrl ?? "",
    migrateCommand: existing?.migrateCommand ?? "",
    testCommand: existing?.testCommand ?? "",
    coverageFormat: existing?.coverageFormat ?? "LCOV",
    coverageReportPath: existing?.coverageReportPath ?? "coverage/lcov.info",
    lintCommand: existing?.lintCommand ?? "",
    formatCommand: existing?.formatCommand ?? "",
    dockerfilePath: existing?.dockerfilePath ?? "",
    instructions: existing?.instructions ?? "",
    coverageBar: String(existing?.coverageBar ?? 100),
  };
}

export function ProjectForm({
  existing,
  headerless = false,
}: {
  existing?: ProjectFormData;
  /** Drop the project-name heading when the page already renders one. */
  headerless?: boolean;
}) {
  const router = useRouter();
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const isNew = !existing?.id;

  const formik = useFormik<ProjectValues>({
    initialValues: toValues(existing),
    validationSchema: ProjectSchema,
    onSubmit: async (values, helpers) => {
      helpers.setStatus(undefined);
      const payload = {
        name: values.name.trim(),
        repoUrl: values.repoUrl.trim(),
        defaultBranch: values.defaultBranch.trim(),
        branchTemplate: values.branchTemplate.trim(),
        setupCommand: values.setupCommand.trim(),
        runCommand: values.runCommand.trim(),
        runReadyUrl: values.runReadyUrl.trim() || null,
        migrateCommand: values.migrateCommand.trim() || null,
        testCommand: values.testCommand.trim(),
        coverageFormat: values.coverageFormat,
        coverageReportPath: values.coverageReportPath.trim(),
        lintCommand: values.lintCommand.trim() || null,
        formatCommand: values.formatCommand.trim() || null,
        dockerfilePath: values.dockerfilePath.trim() || null,
        instructions: values.instructions,
        coverageBar: Number(values.coverageBar),
      };
      try {
        if (isNew) {
          const res = await apiFetch<{ id: string }>("/api/projects", {
            method: "POST",
            body: JSON.stringify(payload),
          });
          router.push(`/projects/${res.id}`);
        } else {
          await apiFetch(`/api/projects/${existing?.id}`, {
            method: "PATCH",
            body: JSON.stringify(payload),
          });
          helpers.setSubmitting(false);
          router.refresh();
        }
      } catch (err) {
        helpers.setStatus(err instanceof Error ? err.message : String(err));
        helpers.setSubmitting(false);
      }
    },
  });

  async function remove() {
    if (!existing?.id || !confirm(`Delete project "${existing.name}"?`)) return;
    setBusy(true);
    setActionError(null);
    try {
      await apiFetch(`/api/projects/${existing.id}`, { method: "DELETE" });
      router.push("/projects");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  async function verify() {
    if (!existing?.id) return;
    setVerifying(true);
    setActionError(null);
    try {
      const res = await apiFetch<{ taskId: string }>(`/api/projects/${existing.id}/verify`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      router.push(`/tasks/${res.taskId}`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
      setVerifying(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className={clsx("flex items-center", headerless ? "justify-end" : "justify-between")}>
        {headerless ? null : <Heading>{isNew ? "New Project" : existing?.name}</Heading>}
        {!isNew ? (
          <Button type="button" variant="outline" loading={verifying} onClick={verify}>
            Verify
          </Button>
        ) : null}
      </div>

      <form onSubmit={formik.handleSubmit} noValidate>
        <Card className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name">
              <Input {...formik.getFieldProps("name")} />
              <ErrorText>{fieldError(formik, "name")}</ErrorText>
            </Field>
            <Field label="Repo URL (https clone)">
              <Input
                placeholder="https://github.com/org/repo.git"
                {...formik.getFieldProps("repoUrl")}
              />
              <ErrorText>{fieldError(formik, "repoUrl")}</ErrorText>
            </Field>
            <Field label="Default branch">
              <Input {...formik.getFieldProps("defaultBranch")} />
              <ErrorText>{fieldError(formik, "defaultBranch")}</ErrorText>
            </Field>
            <Field label="Branch template" hint="Placeholders: {id} {slug} {difficulty} {project}">
              <Input {...formik.getFieldProps("branchTemplate")} />
              <ErrorText>{fieldError(formik, "branchTemplate")}</ErrorText>
            </Field>
          </div>
          <Field label="Setup command" hint='e.g. "bun install && bun db:push"'>
            <Input {...formik.getFieldProps("setupCommand")} />
            <ErrorText>{fieldError(formik, "setupCommand")}</ErrorText>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Run command" hint="Starts the app for the testing stage">
              <Input {...formik.getFieldProps("runCommand")} />
              <ErrorText>{fieldError(formik, "runCommand")}</ErrorText>
            </Field>
            <Field label="Ready URL" hint="Polled to detect the app is up">
              <Input placeholder="http://localhost:3000" {...formik.getFieldProps("runReadyUrl")} />
              <ErrorText>{fieldError(formik, "runReadyUrl")}</ErrorText>
            </Field>
            <Field label="Migrate command (optional)">
              <Input {...formik.getFieldProps("migrateCommand")} />
            </Field>
            <Field label="Test command" hint="Must emit a coverage report">
              <Input {...formik.getFieldProps("testCommand")} />
              <ErrorText>{fieldError(formik, "testCommand")}</ErrorText>
            </Field>
            <Field label="Coverage format">
              <Select {...formik.getFieldProps("coverageFormat")}>
                {COVERAGE_FORMATS.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Coverage report path">
              <Input {...formik.getFieldProps("coverageReportPath")} />
              <ErrorText>{fieldError(formik, "coverageReportPath")}</ErrorText>
            </Field>
            <Field label="Coverage bar (% of changed lines)">
              <Input type="number" min={0} max={100} {...formik.getFieldProps("coverageBar")} />
              <ErrorText>{fieldError(formik, "coverageBar")}</ErrorText>
            </Field>
            <Field
              label="Custom Dockerfile path (optional)"
              hint="Must FROM waypoint-runner:latest"
            >
              <Input {...formik.getFieldProps("dockerfilePath")} />
            </Field>
            <Field label="Lint command (optional)">
              <Input {...formik.getFieldProps("lintCommand")} />
            </Field>
            <Field label="Format command (optional)">
              <Input {...formik.getFieldProps("formatCommand")} />
            </Field>
          </div>
          <Field
            label="Project instructions"
            hint="CLAUDE.md content injected into every stage prompt"
          >
            <Textarea rows={5} {...formik.getFieldProps("instructions")} />
          </Field>

          {formik.status ? <p className="text-sm text-red-400">{formik.status}</p> : null}
          {actionError ? <p className="text-sm text-red-400">{actionError}</p> : null}
          <div className="flex justify-between">
            {!isNew ? (
              <Button type="button" variant="danger" disabled={busy} onClick={remove}>
                Delete
              </Button>
            ) : (
              <span />
            )}
            <Button type="submit" variant="primary" disabled={busy} loading={formik.isSubmitting}>
              {isNew ? "Create project" : "Save changes"}
            </Button>
          </div>
        </Card>
      </form>

      {!isNew && existing?.id ? (
        <SecretsManager projectId={existing.id} initial={existing.secrets ?? []} />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

const SecretSchema = Yup.object({
  key: Yup.string()
    .matches(/^[A-Z][A-Z0-9_]*$/i, "Env-var style name (letters, digits, underscores)")
    .required("Key is required"),
  value: Yup.string().required("Value is required"),
});

/** Write-only secrets manager (§9): name + "set" indicator, never echo values. */
function SecretsManager({ projectId, initial }: { projectId: string; initial: string[] }) {
  const [keys, setKeys] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function put(key: string, value: string | null): Promise<void> {
    setError(null);
    await apiFetch(`/api/projects/${projectId}/secrets/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    });
    setKeys((k) =>
      value === null ? k.filter((x) => x !== key) : k.includes(key) ? k : [...k, key].toSorted(),
    );
  }

  const addForm = useFormik({
    initialValues: { key: "", value: "" },
    validationSchema: SecretSchema,
    onSubmit: async (values, helpers) => {
      try {
        await put(values.key.toUpperCase(), values.value);
        helpers.resetForm();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        helpers.setSubmitting(false);
      }
    },
  });

  async function removeKey(key: string) {
    setBusy(true);
    try {
      await put(key, null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-3">
      <Subheading>Secrets</Subheading>
      <p className="text-xs text-zinc-500">
        Injected as env vars into this project’s task containers. Values are write-only — encrypted
        at rest, never shown again. Use key <code>GIT_PAT</code> to override the global GitHub PAT
        for this repo.
      </p>
      {keys.length ? (
        <ul className="space-y-1.5">
          {keys.map((key) => (
            <li
              key={key}
              className="flex items-center justify-between rounded-lg bg-zinc-900 px-3 py-1.5"
            >
              <span className="flex items-center gap-2 text-sm">
                <code className="text-zinc-200">{key}</code>
                <Badge color="green">set</Badge>
              </span>
              <span className="flex gap-2">
                <RotateSecretForm
                  onRotate={async (value) => {
                    try {
                      await put(key, value);
                    } catch (err) {
                      setError(err instanceof Error ? err.message : String(err));
                    }
                  }}
                />
                <Button
                  small
                  variant="ghost"
                  type="button"
                  disabled={busy}
                  onClick={() => removeKey(key)}
                >
                  Remove
                </Button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-zinc-600">No secrets set.</p>
      )}

      <form onSubmit={addForm.handleSubmit} noValidate className="flex items-start gap-2">
        <Field label="Key" className="w-48">
          <Input placeholder="DATABASE_URL" {...addForm.getFieldProps("key")} />
          <ErrorText>{fieldError(addForm, "key")}</ErrorText>
        </Field>
        <Field label="Value" className="flex-1">
          <Input type="password" autoComplete="off" {...addForm.getFieldProps("value")} />
          <ErrorText>{fieldError(addForm, "value")}</ErrorText>
        </Field>
        <Button type="submit" variant="outline" className="mt-5" loading={addForm.isSubmitting}>
          Add
        </Button>
      </form>
      {error ? <p className="text-sm text-red-400">{error}</p> : null}
    </Card>
  );
}

const RotateSchema = Yup.object({ value: Yup.string().required("Required") });

function RotateSecretForm({ onRotate }: { onRotate: (value: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const formik = useFormik({
    initialValues: { value: "" },
    validationSchema: RotateSchema,
    onSubmit: async (values, helpers) => {
      await onRotate(values.value);
      helpers.resetForm();
      helpers.setSubmitting(false);
      setOpen(false);
    },
  });

  if (!open) {
    return (
      <Button small variant="ghost" type="button" onClick={() => setOpen(true)}>
        Rotate
      </Button>
    );
  }
  return (
    <form onSubmit={formik.handleSubmit} noValidate className="flex items-center gap-1">
      <Input
        type="password"
        className="w-40"
        autoComplete="off"
        placeholder="New value"
        {...formik.getFieldProps("value")}
      />
      <Button small variant="outline" type="submit" loading={formik.isSubmitting}>
        Save
      </Button>
      <Button small variant="ghost" type="button" onClick={() => setOpen(false)}>
        ✕
      </Button>
    </form>
  );
}
