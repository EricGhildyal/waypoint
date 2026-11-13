"use client";

import clsx from "clsx";
import { type FormikProps, useFormik } from "formik";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import * as Yup from "yup";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Field,
  Heading,
  Input,
  Select,
  Subheading,
  Textarea,
} from "@/components/catalyst";
import { ErrorText, emptyToNull, fieldError, urlOrLocalhost } from "@/components/form-utils";
import type { TestSuite } from "@waypoint/core";
import type { DetectedCommands } from "@/lib/detect-commands";
import { apiFetch } from "@/lib/format";
import { parseEnv } from "@/lib/parse-env";

// Copied rather than imported from @waypoint/core, which would pull Prisma
// into the client bundle.
const COVERAGE_FORMATS = [
  "LCOV",
  "COBERTURA_XML",
  "CLOVER_XML",
  "JACOCO_XML",
  "GO_COVERPROFILE",
] as const;

/** A test suite as the form holds it: the bar stays text until submit. */
type SuiteValues = Omit<TestSuite, "coverageBar"> & { coverageBar: string };

const blankSuite = (name: string): SuiteValues => ({
  name,
  command: "",
  workdir: "",
  coverageEnabled: true,
  coverageFormat: "LCOV",
  coverageReportPath: "coverage/lcov.info",
  coverageBar: "100",
});

function toSuiteValues(suite: TestSuite): SuiteValues {
  const { coverageBar, ...rest } = suite;
  return { ...rest, coverageBar: String(coverageBar) };
}

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
  testSuites: TestSuite[];
  lintCommand: string | null;
  formatCommand: string | null;
  dockerfilePath: string | null;
  dockerEnabled: boolean;
  instructions: string;
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
  testSuites: SuiteValues[];
  lintCommand: string;
  formatCommand: string;
  dockerfilePath: string;
  dockerEnabled: boolean;
  instructions: string;
}

/** The fields a repository scan can fill in. */
const DETECTABLE = [
  ["setupCommand", "setup command"],
  ["runCommand", "run command"],
  ["runReadyUrl", "ready URL"],
  ["migrateCommand", "migrate command"],
  ["lintCommand", "lint command"],
  ["formatCommand", "format command"],
] as const;

const ProjectSchema = Yup.object({
  name: Yup.string().trim().max(100, "Keep it under 100 characters").required("Name is required"),
  repoUrl: Yup.string().url("Must be a valid https clone URL").required("Repo URL is required"),
  defaultBranch: Yup.string().trim().required("Required"),
  branchTemplate: Yup.string().trim().required("Required"),
  setupCommand: Yup.string().trim().required("Setup command is required"),
  runCommand: Yup.string().trim().required("Run command is required"),
  runReadyUrl: urlOrLocalhost("Must be a URL").nullable().transform(emptyToNull),
  migrateCommand: Yup.string().nullable(),
  testSuites: Yup.array()
    .of(
      Yup.object({
        name: Yup.string().trim().max(40, "Keep it under 40 characters").required("Required"),
        command: Yup.string().trim().required("Required"),
        workdir: Yup.string()
          .trim()
          .test(
            "inside-repo",
            "A folder inside the repository",
            (v) => !v || (!v.startsWith("/") && !v.split("/").includes("..")),
          ),
        coverageEnabled: Yup.boolean(),
        coverageFormat: Yup.string().oneOf([...COVERAGE_FORMATS]),
        // coverage fields only matter while coverage is required
        coverageReportPath: Yup.string()
          .trim()
          .when("coverageEnabled", { is: true, then: (s) => s.required("Required") }),
        coverageBar: Yup.string().when("coverageEnabled", {
          is: true,
          then: () =>
            Yup.number()
              .typeError("0–100")
              .integer("Whole percent")
              .min(0, "0–100")
              .max(100, "0–100")
              .required("Required"),
        }),
      }),
    )
    .test("unique-names", "Test suite names must be unique", (suites) => {
      const names = (suites ?? []).map((s) => (s.name ?? "").trim().toLowerCase());
      return new Set(names).size === names.length;
    }),
  lintCommand: Yup.string().nullable(),
  formatCommand: Yup.string().nullable(),
  dockerfilePath: Yup.string().nullable(),
  dockerEnabled: Yup.boolean(),
  instructions: Yup.string(),
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
    testSuites: (existing?.testSuites ?? []).map(toSuiteValues),
    lintCommand: existing?.lintCommand ?? "",
    formatCommand: existing?.formatCommand ?? "",
    dockerfilePath: existing?.dockerfilePath ?? "",
    dockerEnabled: existing?.dockerEnabled ?? false,
    instructions: existing?.instructions ?? "",
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
  const [detecting, setDetecting] = useState(false);
  const [detected, setDetected] = useState<{ summary: string; notes: string[] } | null>(null);
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
        testSuites: values.testSuites.map((s) => ({
          name: s.name.trim(),
          command: s.command.trim(),
          workdir: s.workdir.trim().replace(/^\.\/|\/+$/g, ""),
          coverageEnabled: s.coverageEnabled,
          coverageFormat: s.coverageFormat,
          // blank coverage fields only pass validation with coverage off; the
          // values are unused then, so fall back to the defaults
          coverageReportPath: s.coverageReportPath.trim() || "coverage/lcov.info",
          // a number input hands formik a number once edited, a string before
          coverageBar: String(s.coverageBar).trim() === "" ? 100 : Number(s.coverageBar),
        })),
        lintCommand: values.lintCommand.trim() || null,
        formatCommand: values.formatCommand.trim() || null,
        dockerfilePath: values.dockerfilePath.trim() || null,
        dockerEnabled: values.dockerEnabled,
        instructions: values.instructions,
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

  /**
   * Read the repository's Makefile, compose file and package.json and fill in
   * the commands they suggest. Only blank fields are filled, so nothing typed
   * is overwritten; clear a field to have it detected again.
   */
  async function detect() {
    setDetecting(true);
    setDetected(null);
    setActionError(null);
    try {
      const found = await apiFetch<DetectedCommands>("/api/projects/detect", {
        method: "POST",
        body: JSON.stringify({
          repoUrl: formik.values.repoUrl.trim(),
          defaultBranch: formik.values.defaultBranch.trim() || "main",
          ...(existing?.id ? { projectId: existing.id } : {}),
        }),
      });
      const filled: string[] = [];
      for (const [field, label] of DETECTABLE) {
        const value = found[field];
        if (value && !formik.values[field].trim()) {
          await formik.setFieldValue(field, value);
          filled.push(label);
        }
      }
      // a detected test command becomes the first suite; one that writes no
      // report only works with coverage off
      if (found.testCommand && !formik.values.testSuites.length) {
        await formik.setFieldValue("testSuites", [
          {
            ...blankSuite("tests"),
            command: found.testCommand,
            coverageEnabled: !found.testWithoutCoverage,
          },
        ]);
        filled.push("test suite");
      }
      if (found.dockerEnabled && !formik.values.dockerEnabled) {
        await formik.setFieldValue("dockerEnabled", true);
        filled.push("Docker inside tasks");
      }
      setDetected({
        summary: filled.length
          ? `Filled in from the repository: ${filled.join(", ")}. Check them before saving.`
          : "Nothing new to fill in — every field the repository suggests already has a value.",
        notes: found.notes,
      });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setDetecting(false);
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
          <div className="space-y-2 rounded-lg bg-zinc-900 px-3 py-2.5">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-zinc-500">
                Fill in the blank commands below from the repository’s Makefile, compose file and
                package.json.
              </p>
              <Button
                type="button"
                variant="outline"
                small
                className="shrink-0"
                disabled={!formik.values.repoUrl.trim()}
                loading={detecting}
                onClick={detect}
              >
                Detect commands
              </Button>
            </div>
            {detected ? (
              <div className="space-y-1 text-xs">
                <p className="text-zinc-300">{detected.summary}</p>
                {detected.notes.map((note) => (
                  <p key={note} className="text-amber-300/90">
                    {note}
                  </p>
                ))}
              </div>
            ) : null}
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
          <TestSuitesEditor formik={formik} />
          <label htmlFor="dockerEnabled" className="flex items-start gap-3">
            <Checkbox
              id="dockerEnabled"
              className="mt-0.5"
              {...formik.getFieldProps({ name: "dockerEnabled", type: "checkbox" })}
            />
            <span>
              <span className="block text-sm text-zinc-200">Docker inside tasks</span>
              <span className="block text-xs text-zinc-500">
                Each task runs its own Docker, so the commands above can use docker compose — a
                database, backend and frontend together. Published ports are reachable on localhost.
                Turn it on only for repositories you trust: these task containers run with elevated
                privileges unless the host has an isolating runtime configured.
              </span>
            </span>
          </label>
          <Field
            label="Project instructions"
            hint="Given to every agent stage, together with the repository's own CLAUDE.md and AGENTS.md, which are read automatically. Use this for anything those files don't say."
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
          <Input type="text" autoComplete="off" {...addForm.getFieldProps("value")} />
          <ErrorText>{fieldError(addForm, "value")}</ErrorText>
        </Field>
        <Button type="submit" variant="outline" className="mt-5" loading={addForm.isSubmitting}>
          Add
        </Button>
      </form>
      <PasteEnvForm existing={keys} put={put} />
      {error ? <p className="text-sm text-red-400">{error}</p> : null}
    </Card>
  );
}

/**
 * Paste a whole .env file: each `KEY=value` line becomes its own secret, under
 * the key as written. Nothing is saved until the button is pressed, and the
 * preview names keys only — values stay in the box.
 */
function PasteEnvForm({
  existing,
  put,
}: {
  existing: string[];
  put: (key: string, value: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const parsed = useMemo(() => parseEnv(text), [text]);
  const replacing = parsed.entries.filter(([key]) => existing.includes(key)).length;

  async function save() {
    setSaving(true);
    setResult(null);
    const failed: string[] = [];
    for (const [key, value] of parsed.entries) {
      try {
        await put(key, value);
      } catch {
        failed.push(key);
      }
    }
    setSaving(false);
    const saved = parsed.entries.length - failed.length;
    if (failed.length) {
      setResult({
        ok: false,
        message: `Saved ${saved} of ${parsed.entries.length}. Could not save: ${failed.join(", ")}.`,
      });
      return;
    }
    setResult({ ok: true, message: `Saved ${saved} secret${saved === 1 ? "" : "s"}.` });
    setText("");
    setOpen(false);
  }

  if (!open) {
    return (
      <div className="flex items-center gap-3">
        <Button
          small
          variant="ghost"
          type="button"
          onClick={() => {
            setResult(null);
            setOpen(true);
          }}
        >
          Paste a .env file
        </Button>
        {result ? (
          <span className={clsx("text-xs", result.ok ? "text-green-300" : "text-red-400")}>
            {result.message}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-lg bg-zinc-900 p-3">
      <Field
        label="Paste a .env file"
        hint="One KEY=value per line. Comments, export and quoted values are understood."
      >
        <Textarea
          rows={6}
          autoComplete="off"
          spellCheck={false}
          className="font-mono text-xs"
          placeholder={"DATABASE_URL=postgres://…\nAPI_KEY=…"}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </Field>
      {parsed.entries.length ? (
        <p className="text-xs text-zinc-400">
          {parsed.entries.length} secret{parsed.entries.length === 1 ? "" : "s"} found:{" "}
          {parsed.entries.map(([key], i) => (
            <span key={key}>
              {i ? ", " : ""}
              <code className={existing.includes(key) ? "text-amber-300" : "text-zinc-200"}>
                {key}
              </code>
            </span>
          ))}
          {replacing ? (
            <span className="text-amber-300"> — {replacing} already set and will be replaced</span>
          ) : null}
        </p>
      ) : null}
      {parsed.skipped.length ? (
        <ul className="text-xs text-zinc-500">
          {parsed.skipped.map((s) => (
            <li key={s.line}>
              Line {s.line} skipped (<code>{s.text}</code>): {s.reason}
            </li>
          ))}
        </ul>
      ) : null}
      {result ? <p className="text-xs text-red-400">{result.message}</p> : null}
      <div className="flex justify-end gap-2">
        <Button
          small
          variant="ghost"
          type="button"
          disabled={saving}
          onClick={() => {
            setText("");
            setOpen(false);
          }}
        >
          Cancel
        </Button>
        <Button
          small
          variant="primary"
          type="button"
          disabled={parsed.entries.length === 0}
          loading={saving}
          onClick={save}
        >
          {parsed.entries.length
            ? `Save ${parsed.entries.length} secret${parsed.entries.length === 1 ? "" : "s"}`
            : "Save secrets"}
        </Button>
      </div>
    </div>
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
        type="text"
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

/**
 * The project's test suites: each is run and enforced on its own after
 * implementation — its own command, folder and coverage rules — so a frontend
 * and a backend don't have to share one command or one bar.
 */
function TestSuitesEditor({ formik }: { formik: FormikProps<ProjectValues> }) {
  const suites = formik.values.testSuites;
  const setSuites = (next: SuiteValues[]) => formik.setFieldValue("testSuites", next);
  const listError = typeof formik.errors.testSuites === "string" ? formik.errors.testSuites : null;
  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-medium text-zinc-200">Test suites (optional)</p>
        <p className="text-xs text-zinc-500">
          Every suite has to pass before a task moves on, and each is checked against its own
          coverage rules — add one per part of the app, such as backend and frontend. With none,
          there is no test gate.
        </p>
      </div>
      {suites.map((suite, i) => {
        const field = (name: keyof SuiteValues) => `testSuites.${i}.${name}`;
        const noCoverage = !suite.coverageEnabled;
        return (
          // suites have no stable id and are only ever removed by index
          // eslint-disable-next-line react/no-array-index-key
          <div key={i} className="space-y-4 rounded-lg border border-zinc-800 p-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name">
                <Input placeholder="backend" {...formik.getFieldProps(field("name"))} />
                <ErrorText>{fieldError(formik, field("name"))}</ErrorText>
              </Field>
              <Field
                label="Folder (optional)"
                hint="Where the command runs — blank for the repository root"
              >
                <Input placeholder="backend" {...formik.getFieldProps(field("workdir"))} />
                <ErrorText>{fieldError(formik, field("workdir"))}</ErrorText>
              </Field>
            </div>
            <Field label="Test command">
              <Input
                placeholder="uv run pytest --cov --cov-report=xml"
                {...formik.getFieldProps(field("command"))}
              />
              <ErrorText>{fieldError(formik, field("command"))}</ErrorText>
            </Field>
            <label htmlFor={`suite-${i}-coverage`} className="flex items-start gap-3">
              <Checkbox
                id={`suite-${i}-coverage`}
                className="mt-0.5"
                {...formik.getFieldProps({ name: field("coverageEnabled"), type: "checkbox" })}
              />
              <span>
                <span className="block text-sm text-zinc-200">Require test coverage</span>
                <span className="block text-xs text-zinc-500">
                  The command must write a coverage report, and the lines a task changes in this
                  suite&apos;s code must meet the bar. Off: the tests only have to pass.
                </span>
              </span>
            </label>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Coverage format">
                <Select disabled={noCoverage} {...formik.getFieldProps(field("coverageFormat"))}>
                  {COVERAGE_FORMATS.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Report path" hint="Relative to the folder">
                <Input
                  disabled={noCoverage}
                  {...formik.getFieldProps(field("coverageReportPath"))}
                />
                <ErrorText>{fieldError(formik, field("coverageReportPath"))}</ErrorText>
              </Field>
              <Field label="Bar (% of changed lines)">
                <Input
                  type="number"
                  min={0}
                  max={100}
                  disabled={noCoverage}
                  {...formik.getFieldProps(field("coverageBar"))}
                />
                <ErrorText>{fieldError(formik, field("coverageBar"))}</ErrorText>
              </Field>
            </div>
            <div className="flex justify-end">
              <Button
                type="button"
                variant="outline"
                onClick={() => setSuites(suites.filter((_, at) => at !== i))}
              >
                Remove suite
              </Button>
            </div>
          </div>
        );
      })}
      <ErrorText>{listError}</ErrorText>
      <Button
        type="button"
        variant="outline"
        onClick={() => setSuites([...suites, blankSuite(suites.length ? "" : "tests")])}
      >
        Add test suite
      </Button>
    </div>
  );
}
