# e2e

Playwright specs that drive the real web app in a browser.

```sh
make run          # or: bun run dev:web — the suite does not boot the app
bun run e2e       # runs e2e/specs/*.spec.ts against http://localhost:3000
```

- `E2E_BASE_URL` points the suite at another instance.
- `fixtures/seed.ts` creates the `e2e-fixtures` project and a task pinned to each
  UI state the specs need (running / open question / plan approval / long prompt /
  blank prompt / failed / finished-with-history). It is idempotent and re-runs
  before every test, so specs may consume fixture state.
- The web app must be running with `AUTH_DEV_BYPASS=1` (the `make run` default);
  the specs do not perform Google sign-in.

## Outbound email

`email-threading.spec.ts` covers mail the orchestrator sends (§8) — one Gmail
thread per task, and plan approvals rendered from markdown. It needs no web app:

- `fixtures/email-dispatch.ts` runs the real `dispatchEmails()` in a subprocess
  with its Resend client pointed at a local fake HTTP server (via
  `RESEND_BASE_URL`), walks a task through plan → question → findings → done,
  and prints every captured message as JSON. Nothing is stubbed but the network.
- The spec asserts on those subjects/headers, then loads each email's HTML into
  the browser to check it as a document (headings, lists, escaping).
- The driver restores the dev DB afterwards: its fixture tasks are deleted, and
  any unrelated row it marked as emailed is reset, so a later real send is not
  suppressed.
