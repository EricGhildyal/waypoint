"use client";

import { useFormik } from "formik";
import { useState } from "react";
import * as Yup from "yup";
import {
  Badge,
  Button,
  ButtonGroup,
  Card,
  Field,
  Heading,
  Input,
  Select,
  Subheading,
  YES_NO_OPTIONS,
} from "@/components/catalyst";
import { ErrorText, fieldError, urlOrLocalhost } from "@/components/form-utils";
import { apiFetch } from "@/lib/format";

export function SettingsForm({
  initialSettings,
  initialModels,
  initialEmails,
  claudeTokenSet,
  githubPatSet,
}: {
  initialSettings: Record<string, string>;
  initialModels: string[];
  initialEmails: string[];
  claudeTokenSet: boolean;
  githubPatSet: boolean;
}) {
  const [models, setModels] = useState(initialModels);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Heading>Settings</Heading>
      <ExecutionSettings
        initialSettings={initialSettings}
        models={models}
        setModels={setModels}
        onResult={(m, e) => {
          setMsg(m);
          setError(e);
        }}
      />
      <Credentials
        claudeTokenSet={claudeTokenSet}
        githubPatSet={githubPatSet}
        onResult={(m, e) => {
          setMsg(m);
          setError(e);
        }}
      />
      <AllowedEmails
        initialEmails={initialEmails}
        onResult={(m, e) => {
          setMsg(m);
          setError(e);
        }}
      />
      {msg ? <p className="text-sm text-green-400">{msg}</p> : null}
      {error ? <p className="text-sm text-red-400">{error}</p> : null}
    </div>
  );
}

// --- execution -------------------------------------------------------------

const ExecutionSchema = Yup.object({
  maxParallelTasks: Yup.number()
    .typeError("Must be a number")
    .integer("Whole number")
    .min(1, "At least 1")
    .required("Required"),
  containerMemGb: Yup.number()
    .typeError("Must be a number")
    .min(1, "At least 1 GB")
    .required("Required"),
  containerCpus: Yup.number()
    .typeError("Must be a number")
    .min(1, "At least 1")
    .required("Required"),
  defaultModel: Yup.string().required("Required"),
  appUrl: urlOrLocalhost("Must be a URL").required("Required"),
  notifyOnDone: Yup.string().oneOf(["true", "false"]),
  notifyOnNeedsInput: Yup.string().oneOf(["true", "false"]),
  notifyOnFailed: Yup.string().oneOf(["true", "false"]),
});

function ExecutionSettings({
  initialSettings,
  models,
  setModels,
  onResult,
}: {
  initialSettings: Record<string, string>;
  models: string[];
  setModels: (models: string[]) => void;
  onResult: (msg: string | null, err: string | null) => void;
}) {
  const [refreshing, setRefreshing] = useState(false);

  const formik = useFormik({
    initialValues: {
      maxParallelTasks: initialSettings.maxParallelTasks ?? "3",
      containerMemGb: initialSettings.containerMemGb ?? "6",
      containerCpus: initialSettings.containerCpus ?? "2",
      defaultModel: initialSettings.defaultModel ?? "claude-fable-5",
      appUrl: initialSettings.appUrl ?? "",
      notifyOnDone: initialSettings.notifyOnDone ?? "true",
      notifyOnNeedsInput: initialSettings.notifyOnNeedsInput ?? "true",
      notifyOnFailed: initialSettings.notifyOnFailed ?? "true",
    },
    validationSchema: ExecutionSchema,
    onSubmit: async (values, helpers) => {
      try {
        await apiFetch("/api/settings", {
          method: "PATCH",
          body: JSON.stringify({ settings: values }),
        });
        onResult("Settings saved.", null);
      } catch (err) {
        onResult(null, err instanceof Error ? err.message : String(err));
      } finally {
        helpers.setSubmitting(false);
      }
    },
  });

  async function refreshModels() {
    setRefreshing(true);
    try {
      const res = await apiFetch<{ models: string[] }>("/api/settings/refresh-models", {
        method: "POST",
        body: JSON.stringify({}),
      });
      setModels(res.models);
      onResult(`Model list refreshed (${res.models.length} models).`, null);
    } catch (err) {
      onResult(null, err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  }

  const modelOptions = models.includes(formik.values.defaultModel)
    ? models
    : [formik.values.defaultModel, ...models];

  return (
    <form onSubmit={formik.handleSubmit} noValidate>
      <Card className="space-y-4">
        <Subheading>Execution</Subheading>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Max parallel tasks">
            <Input type="number" min={1} {...formik.getFieldProps("maxParallelTasks")} />
            <ErrorText>{fieldError(formik, "maxParallelTasks")}</ErrorText>
          </Field>
          <Field label="Container memory (GB)">
            <Input type="number" min={1} {...formik.getFieldProps("containerMemGb")} />
            <ErrorText>{fieldError(formik, "containerMemGb")}</ErrorText>
          </Field>
          <Field label="Container CPUs">
            <Input type="number" min={1} {...formik.getFieldProps("containerCpus")} />
            <ErrorText>{fieldError(formik, "containerCpus")}</ErrorText>
          </Field>
        </div>
        <div className="flex items-end gap-2">
          <Field label="Default model" className="flex-1">
            <Select {...formik.getFieldProps("defaultModel")}>
              {modelOptions.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
            <ErrorText>{fieldError(formik, "defaultModel")}</ErrorText>
          </Field>
          <Button type="button" variant="outline" loading={refreshing} onClick={refreshModels}>
            Refresh models
          </Button>
        </div>
        <Field label="App URL" hint="Used in email deeplinks">
          <Input {...formik.getFieldProps("appUrl")} />
          <ErrorText>{fieldError(formik, "appUrl")}</ErrorText>
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
          {(
            [
              ["notifyOnDone", "Email on done"],
              ["notifyOnNeedsInput", "Email on needs-input"],
              ["notifyOnFailed", "Email on failed"],
            ] as const
          ).map(([key, label]) => (
            <Field key={key} label={label}>
              <ButtonGroup
                full
                aria-label={label}
                options={YES_NO_OPTIONS}
                value={formik.values[key]}
                onChange={(v) => formik.setFieldValue(key, v)}
              />
            </Field>
          ))}
        </div>
        <div className="flex justify-end">
          <Button type="submit" variant="primary" loading={formik.isSubmitting}>
            Save settings
          </Button>
        </div>
      </Card>
    </form>
  );
}

// --- credentials -----------------------------------------------------------

const CredentialSchema = Yup.object({
  value: Yup.string().trim().required("Paste the new value first"),
});

function Credentials({
  claudeTokenSet,
  githubPatSet,
  onResult,
}: {
  claudeTokenSet: boolean;
  githubPatSet: boolean;
  onResult: (msg: string | null, err: string | null) => void;
}) {
  return (
    <Card className="space-y-3">
      <Subheading>Credentials</Subheading>
      <CredentialRotation
        label="Claude OAuth token"
        hint="From `claude setup-token` — rotatable anytime; new/recreated containers pick up the latest value."
        field="claudeOauthToken"
        initiallySet={claudeTokenSet}
        onResult={onResult}
      />
      <CredentialRotation
        label="Default GitHub PAT"
        hint="Global fallback; projects can override with a GIT_PAT secret."
        field="githubPat"
        initiallySet={githubPatSet}
        onResult={onResult}
      />
    </Card>
  );
}

function CredentialRotation({
  label,
  hint,
  field,
  initiallySet,
  onResult,
}: {
  label: string;
  hint: string;
  field: "claudeOauthToken" | "githubPat";
  initiallySet: boolean;
  onResult: (msg: string | null, err: string | null) => void;
}) {
  const [isSet, setIsSet] = useState(initiallySet);
  const formik = useFormik({
    initialValues: { value: "" },
    validationSchema: CredentialSchema,
    onSubmit: async (values, helpers) => {
      try {
        await apiFetch("/api/settings", {
          method: "PATCH",
          body: JSON.stringify({ [field]: values.value.trim() }),
        });
        setIsSet(true);
        helpers.resetForm();
        onResult(`${label} rotated.`, null);
      } catch (err) {
        onResult(null, err instanceof Error ? err.message : String(err));
      } finally {
        helpers.setSubmitting(false);
      }
    },
  });

  return (
    <form onSubmit={formik.handleSubmit} noValidate className="flex items-end gap-2">
      <Field label={label} className="flex-1" hint={hint}>
        <Input
          type="password"
          autoComplete="off"
          placeholder={isSet ? "•••••• (set)" : "not set"}
          {...formik.getFieldProps("value")}
        />
        <ErrorText>{fieldError(formik, "value")}</ErrorText>
      </Field>
      {isSet ? <Badge color="green">set</Badge> : <Badge color="red">missing</Badge>}
      <Button type="submit" variant="outline" loading={formik.isSubmitting}>
        Rotate
      </Button>
    </form>
  );
}

// --- allowlist -------------------------------------------------------------

const EmailSchema = Yup.object({
  email: Yup.string().email("Must be a valid email").required("Email is required"),
});

function AllowedEmails({
  initialEmails,
  onResult,
}: {
  initialEmails: string[];
  onResult: (msg: string | null, err: string | null) => void;
}) {
  const [emails, setEmails] = useState(initialEmails);
  const [busy, setBusy] = useState(false);

  const formik = useFormik({
    initialValues: { email: "" },
    validationSchema: EmailSchema,
    onSubmit: async (values, helpers) => {
      const email = values.email.trim().toLowerCase();
      try {
        await apiFetch("/api/settings", {
          method: "PATCH",
          body: JSON.stringify({ addEmail: email }),
        });
        setEmails((e) => (e.includes(email) ? e : [...e, email].toSorted()));
        helpers.resetForm();
        onResult(`${email} added to the allowlist.`, null);
      } catch (err) {
        onResult(null, err instanceof Error ? err.message : String(err));
      } finally {
        helpers.setSubmitting(false);
      }
    },
  });

  async function remove(email: string) {
    setBusy(true);
    try {
      await apiFetch("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ removeEmail: email }),
      });
      setEmails((e) => e.filter((x) => x !== email));
      onResult(`${email} removed.`, null);
    } catch (err) {
      onResult(null, err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-3">
      <Subheading>Allowed emails</Subheading>
      <p className="text-xs text-zinc-500">
        Sign-in allowlist, re-checked on every request — removing an email revokes access
        immediately. Also gates reply-by-email.
      </p>
      <ul className="space-y-1.5">
        {emails.map((email) => (
          <li
            key={email}
            className="flex items-center justify-between rounded-lg bg-zinc-900 px-3 py-1.5 text-sm"
          >
            <span className="text-zinc-200">{email}</span>
            <Button
              small
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => remove(email)}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
      <form onSubmit={formik.handleSubmit} noValidate className="flex items-start gap-2">
        <div className="flex-1">
          <Input
            type="email"
            placeholder="someone@example.com"
            {...formik.getFieldProps("email")}
          />
          <ErrorText>{fieldError(formik, "email")}</ErrorText>
        </div>
        <Button type="submit" variant="outline" loading={formik.isSubmitting}>
          Add
        </Button>
      </form>
    </Card>
  );
}
