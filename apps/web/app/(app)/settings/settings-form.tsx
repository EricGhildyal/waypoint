"use client";

import type { StoredUsageWindow } from "@waypoint/core";
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
import { UsageLimitsCard } from "./usage-limits-card";

export function SettingsForm({
  initialSettings,
  initialModels,
  initialEmails,
  usageWindows,
  claudeTokenSet,
  githubPatSet,
  githubBotPatSet,
}: {
  initialSettings: Record<string, string>;
  initialModels: string[];
  initialEmails: string[];
  usageWindows: StoredUsageWindow[];
  claudeTokenSet: boolean;
  githubPatSet: boolean;
  githubBotPatSet: boolean;
}) {
  const [models, setModels] = useState(initialModels);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Heading>Settings</Heading>
      <UsageLimitsCard windows={usageWindows} />
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
        githubBotPatSet={githubBotPatSet}
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
      {/* pinned to the bottom of the viewport: the card that was just saved is
          often a screen above the end of the page, where this would be unseen */}
      {msg || error ? (
        <p
          role="status"
          className={`sticky bottom-4 rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm shadow-lg ${error ? "text-red-400" : "text-green-400"}`}
        >
          {error ?? msg}
        </p>
      ) : null}
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
  defaultPlanningModel: Yup.string().required("Required"),
  defaultImplementationModel: Yup.string().required("Required"),
  defaultReviewModel: Yup.string().required("Required"),
  defaultTestingModel: Yup.string().required("Required"),
  prMergeMethod: Yup.string().oneOf(["merge", "squash", "rebase"]),
  prTrustedLogins: Yup.string().test(
    "logins",
    "Comma-separated GitHub usernames, e.g. octocat, hubot",
    // a typo here would silently stop every comment and approval being acted on
    (value) =>
      parseLogins(value ?? "").every((login) => /^[a-z\d](?:[a-z\d-]{0,38})$/i.test(login)),
  ),
  appUrl: urlOrLocalhost("Must be a URL").required("Required"),
  notifyOnDone: Yup.string().oneOf(["true", "false"]),
  notifyOnNeedsInput: Yup.string().oneOf(["true", "false"]),
  notifyOnFailed: Yup.string().oneOf(["true", "false"]),
  autoApproveEasyPlans: Yup.string().oneOf(["true", "false"]),
});

/** "@Eric, hubot" → ["Eric", "hubot"]: people paste logins with the @. */
function parseLogins(value: string): string[] {
  return value
    .split(",")
    .map((login) => login.trim().replace(/^@/, ""))
    .filter(Boolean);
}

/** Default model per stage; a new task starts from these and can override each. */
const MODEL_FIELDS = [
  ["defaultPlanningModel", "Planning model"],
  ["defaultImplementationModel", "Implementation model"],
  ["defaultReviewModel", "Review model"],
  ["defaultTestingModel", "Testing model"],
] as const;

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
      defaultPlanningModel: initialSettings.defaultPlanningModel ?? "",
      defaultImplementationModel: initialSettings.defaultImplementationModel ?? "",
      defaultReviewModel: initialSettings.defaultReviewModel ?? "",
      defaultTestingModel: initialSettings.defaultTestingModel ?? "",
      prMergeMethod: initialSettings.prMergeMethod ?? "merge",
      prTrustedLogins: initialSettings.prTrustedLogins ?? "",
      appUrl: initialSettings.appUrl ?? "",
      notifyOnDone: initialSettings.notifyOnDone ?? "true",
      notifyOnNeedsInput: initialSettings.notifyOnNeedsInput ?? "true",
      notifyOnFailed: initialSettings.notifyOnFailed ?? "true",
      autoApproveEasyPlans: initialSettings.autoApproveEasyPlans ?? "true",
    },
    validationSchema: ExecutionSchema,
    onSubmit: async (values, helpers) => {
      try {
        await apiFetch("/api/settings", {
          method: "PATCH",
          // settings are stored as strings; a number input hands formik a
          // number once edited, which the API would reject
          body: JSON.stringify({
            settings: Object.fromEntries(
              Object.entries({
                ...values,
                prTrustedLogins: parseLogins(values.prTrustedLogins).join(", "),
              }).map(([key, value]) => [key, String(value)]),
            ),
          }),
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

  // a saved default that is no longer in the fetched list must stay selectable
  const modelOptions = [
    ...new Set([...MODEL_FIELDS.map(([key]) => formik.values[key]), ...models]),
  ].filter(Boolean);

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
        <div className="grid gap-4 sm:grid-cols-2">
          {MODEL_FIELDS.map(([key, label]) => (
            <Field key={key} label={label}>
              <Select {...formik.getFieldProps(key)}>
                {modelOptions.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </Select>
              <ErrorText>{fieldError(formik, key)}</ErrorText>
            </Field>
          ))}
        </div>
        <div className="flex justify-end">
          <Button type="button" variant="outline" loading={refreshing} onClick={refreshModels}>
            Refresh models
          </Button>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="PR merge method" hint="How an approved pull request is merged">
            <Select {...formik.getFieldProps("prMergeMethod")}>
              <option value="merge">Merge commit</option>
              <option value="squash">Squash</option>
              <option value="rebase">Rebase</option>
            </Select>
          </Field>
          <Field
            label="Trusted GitHub logins"
            hint="Comma-separated. Only their PR comments and approvals are acted on. Empty = the owner of the GitHub PAT."
          >
            <Input {...formik.getFieldProps("prTrustedLogins")} />
          </Field>
        </div>
        <Field label="App URL" hint="Used in email deeplinks">
          <Input {...formik.getFieldProps("appUrl")} />
          <ErrorText>{fieldError(formik, "appUrl")}</ErrorText>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          {(
            [
              ["notifyOnDone", "Email on done"],
              ["notifyOnNeedsInput", "Email on needs-input"],
              ["notifyOnFailed", "Email on failed"],
              ["autoApproveEasyPlans", "Auto-approve easy plans"],
            ] as const
          ).map(([key, label]) => (
            <Field key={key} label={label} group>
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
  githubBotPatSet,
  onResult,
}: {
  claudeTokenSet: boolean;
  githubPatSet: boolean;
  githubBotPatSet: boolean;
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
      <CredentialRotation
        label="GitHub bot token"
        hint="A separate bot account with write access to your repos. Waypoint clones, pushes and opens PRs as the bot, so you can approve them — GitHub does not let you approve your own PR. Without it, PRs open under your account. Projects can override with a GIT_BOT_PAT secret."
        field="githubBotPat"
        initiallySet={githubBotPatSet}
        optional
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
  optional = false,
  onResult,
}: {
  label: string;
  hint: string;
  field: "claudeOauthToken" | "githubPat" | "githubBotPat";
  initiallySet: boolean;
  /** An unset optional credential is a choice, not a problem. */
  optional?: boolean;
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

  async function remove() {
    if (!confirm(`Remove the ${label}?`)) return;
    try {
      await apiFetch("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ removeSecret: field }),
      });
      setIsSet(false);
      onResult(`${label} removed.`, null);
    } catch (err) {
      onResult(null, err instanceof Error ? err.message : String(err));
    }
  }

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
      {isSet ? (
        <Badge color="green">set</Badge>
      ) : optional ? (
        <Badge color="zinc">not set</Badge>
      ) : (
        <Badge color="red">missing</Badge>
      )}
      <Button type="submit" variant="outline" loading={formik.isSubmitting}>
        {isSet ? "Rotate" : "Set"}
      </Button>
      {optional && isSet ? (
        <Button type="button" variant="outline" disabled={formik.isSubmitting} onClick={remove}>
          Remove
        </Button>
      ) : null}
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
