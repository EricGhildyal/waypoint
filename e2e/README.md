# e2e

Playwright specs that drive the real web app in a browser.

```sh
make run          # or: bun run dev:web — the suite does not boot the app
bun run e2e       # runs e2e/specs/*.spec.ts against http://localhost:3000
```

- `E2E_BASE_URL` points the suite at another instance.
- `fixtures/seed.ts` creates the `e2e-fixtures` project and a task pinned to each
  UI state the specs need (running / open question / plan approval / long prompt /
  blank prompt / failed). It is idempotent and re-runs before every test, so specs
  may consume fixture state.
- The web app must be running with `AUTH_DEV_BYPASS=1` (the `make run` default);
  the specs do not perform Google sign-in.
