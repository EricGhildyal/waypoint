# Waypoint — Manual Setup Steps

Everything the code can't do for you. Work top to bottom; each section says what
it produces (usually a value for `deploy/.env`). At the end you'll have Waypoint
live at `[MY_URL]`.

The initial Prisma migration is already committed (`packages/core/prisma/migrations/`),
and the database seeds itself on first boot — there are no manual DB steps.

---

## 1. Accounts & credentials to collect

| #   | What                                            | Where it goes                              |
| --- | ----------------------------------------------- | ------------------------------------------ |
| 1.1 | Google OAuth client id + secret                 | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| 1.2 | Resend API key + inbound webhook signing secret | `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`  |
| 1.3 | Claude Max OAuth token (`claude setup-token`)   | `CLAUDE_CODE_OAUTH_TOKEN`                  |
| 1.4 | Anthropic API key (models list only)            | `ANTHROPIC_API_KEY`                        |
| 1.5 | GitHub PAT (repo scope)                         | `GITHUB_DEFAULT_PAT`                       |
| 1.6 | VPS (~20 GB RAM) + Object Storage bucket        | host + `LITESTREAM_*`                      |
| 1.7 | Two generated secrets (`openssl rand …`)        | `AUTH_SECRET`, `MASTER_ENCRYPTION_KEY`     |

Details for each below.

---

## 2. GitHub repository & CI

1. Create the GitHub repo (e.g. `[me]/waypoint`) and push this codebase to `main`.
2. GitHub Actions builds three images to GHCR on every push to `main`
   (`waypoint-web`, `waypoint-orchestrator`, `waypoint-runner`) — no setup
   needed beyond the push (it uses the built-in `GITHUB_TOKEN`).
3. **Make the GHCR packages pullable by the VPS**: after the first CI run, open
   each package on GitHub → Package settings. Either set them Public, or (if
   Private) create a read-only PAT (`read:packages`) and on the VPS run
   `docker login ghcr.io -u <user> -p <token>` once.
4. Add the deploy secrets in the repo → Settings → Secrets and variables → Actions:
   - `VPS_HOST` — the VPS IP
   - `VPS_USER` — the deploy user (e.g. `root` or `deploy`)
   - `VPS_SSH_KEY` — a private SSH key whose public half is on the VPS
5. (Recommended) Create a `production` environment in repo settings — the
   deploy job targets it, so you can add required reviewers/protection later.

**Produces:** automated image builds; the deploy job will work once the VPS exists.

---

## 3. Hetzner VPS provisioning

On a fresh Ubuntu VPS (≈20 GB RAM assumed; the default container limits are
6 GB / 2 CPUs per task × 3 parallel tasks):

```bash
# 3.1 Docker
curl -fsSL https://get.docker.com | sh

# 3.2 Firewall — 22/80/443 only (§11)
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable

# 3.3 SSH hardening: key-only + fail2ban
apt-get update && apt-get install -y fail2ban
# in /etc/ssh/sshd_config set: PasswordAuthentication no, PermitRootLogin prohibit-password
systemctl restart ssh && systemctl enable --now fail2ban

# 3.4 Clone the repo where deploy.sh expects it
mkdir -p /opt && git clone https://github.com/<you>/waypoint.git /opt/waypoint

# 3.5 Create the env file
cp /opt/waypoint/deploy/.env.example /opt/waypoint/deploy/.env
chmod 600 /opt/waypoint/deploy/.env
# fill it in as you complete the sections below
```

Also add the public half of `VPS_SSH_KEY` (step 2.4) to `~/.ssh/authorized_keys`.

**Produces:** a box ready for `deploy.sh`.

---

## 4. DNS for `[MY_DOMAIN]`

The app, email **send**, and email **receive** all live on `waypoint.[MY_DOMAIN]` —
an MX record coexists fine with the A record on the same host (§8).

| Type            | Name                                        | Value                                                                                                | Purpose                                                                 |
| --------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| A               | `waypoint`                                  | `<VPS IP>`                                                                                           | the app; Caddy auto-provisions TLS once this resolves                   |
| TXT + CNAME/TXT | _(exact records from the Resend dashboard)_ | DKIM + SPF                                                                                           | verify `waypoint.[MY_DOMAIN]` as a Resend **sending** domain (step 5.2) |
| MX              | `waypoint`                                  | _(Resend's inbound server, exact value from the dashboard — e.g. `inbound.resend.com`, priority 10)_ | reply-by-email → Resend inbound (step 5.3)                              |
| TXT             | `_dmarc.waypoint`                           | `v=DMARC1; p=none; rua=mailto:[me@email.com]`                                                        | optional, deliverability                                                |

⚠️ Caddy can only obtain the certificate after the A record propagates — create
it before the first deploy.

---

## 5. Resend (outbound + inbound email)

1. **API key** — resend.com → API Keys → create → `RESEND_API_KEY`.
2. **Verify the sending domain** — Domains → Add Domain → `waypoint.[MY_DOMAIN]`.
   Resend shows the exact DKIM/SPF records; add them to DNS (step 4) and wait
   for "Verified". The sender address is `waypoint@waypoint.[MY_DOMAIN]`
   (`EMAIL_FROM`).
3. **Inbound email** — enable receiving for `waypoint.[MY_DOMAIN]` (Resend →
   Domains → your domain → Receiving, or the Inbound section). Add the **MX
   record** it shows (step 4). Question reply-to addresses look like
   `q-<questionId>@waypoint.[MY_DOMAIN]` (`INBOUND_DOMAIN=waypoint.[MY_DOMAIN]`).
4. **Inbound webhook** — Webhooks → Add Endpoint:
   - URL: `https://waypoint.[MY_DOMAIN]/api/webhooks/resend`
   - Event: the inbound "email received" event
   - Copy the **signing secret** (starts `whsec_`) → `RESEND_WEBHOOK_SECRET`.
     (The endpoint verifies Svix signatures; unsigned calls are rejected.)

**Produces:** `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `EMAIL_FROM`, `INBOUND_DOMAIN`.

---

## 6. Google OAuth (app sign-in)

1. [console.cloud.google.com](https://console.cloud.google.com) → create a
   project (e.g. "Waypoint").
2. APIs & Services → OAuth consent screen: External, app name "Waypoint", add
   yourself as a test user (or Publish the app so any allowlisted Google
   account can sign in — Waypoint's own allowlist still gates access).
3. APIs & Services → Credentials → Create Credentials → OAuth client ID →
   **Web application**:
   - Authorized JavaScript origin: `https://waypoint.[MY_DOMAIN]`
   - Authorized redirect URI: `https://waypoint.[MY_DOMAIN]/api/auth/callback/google`
4. Copy the client ID/secret → `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.

**Produces:** Google sign-in for allowlisted emails (allowlist seeds from
`SEED_ALLOWED_EMAILS`, manageable later in Settings).

---

## 7. Claude & Anthropic credentials

1. **Claude Max OAuth token** (all agent traffic bills to your Max
   subscription): on any machine with Claude Code installed and logged in to
   your Max account, run:
   ```bash
   claude setup-token
   ```
   Copy the token → `CLAUDE_CODE_OAUTH_TOKEN`. This env value is a **seed
   only** — after first boot it lives as an encrypted global Secret and is
   rotated anytime from **Settings → Claude OAuth token** (new/recreated task
   containers pick up the latest value).
2. **Anthropic API key** — [platform.claude.com](https://platform.claude.com) →
   API keys. Used **only** for the free `GET /v1/models` list refresh behind
   Settings → "Refresh models" → `ANTHROPIC_API_KEY`.

---

## 8. GitHub PAT (repo access for the agents)

Create a PAT that can clone, push branches, and open PRs on your client repos:

- Fine-grained: Repository access → the repos Waypoint will work on;
  permissions: **Contents: Read and write**, **Pull requests: Read and write**.
- (Or a classic PAT with `repo` scope.)

→ `GITHUB_DEFAULT_PAT` (seeded into the encrypted global `GIT_PAT` Secret on
first boot; rotate later from Settings). Per-project override: add a `GIT_PAT`
secret on the project.

---

## 9. Generated secrets

```bash
openssl rand -base64 32   # → AUTH_SECRET       (Auth.js JWT signing)
openssl rand -hex 32      # → MASTER_ENCRYPTION_KEY (AES-256-GCM for Secret rows; 64 hex chars)
```

⚠️ Back `MASTER_ENCRYPTION_KEY` up somewhere safe — losing it orphans every
stored secret (they'd need re-entering).

---

## 10. Litestream backups (Hetzner Object Storage)

1. Hetzner Console → Object Storage → create a bucket, e.g.
   `waypoint-litestream` (note the location, e.g. `fsn1`).
2. Generate S3 credentials for it.
3. Fill in `.env`:
   ```
   LITESTREAM_ENDPOINT=https://fsn1.your-objectstorage.com
   LITESTREAM_REGION=fsn1
   LITESTREAM_BUCKET=waypoint-litestream
   LITESTREAM_ACCESS_KEY_ID=...
   LITESTREAM_SECRET_ACCESS_KEY=...
   ```

---

## 11. First deploy

1. Finish `deploy/.env` on the VPS (every blank in `.env.example`, including
   `GHCR_USER=<your github username>` and `SEED_ALLOWED_EMAILS`).
2. Push to `main` (or re-run the workflow) and wait for **Build & Deploy →
   build** to publish the three images.
3. First time only, on the VPS:
   ```bash
   cd /opt/waypoint/deploy
   ./deploy.sh
   ```
   (Afterwards the CI deploy job runs this for you on every push to `main`.)
4. Watch it come up: `docker compose ps` — `web` becomes healthy (it snapshots,
   migrates, seeds, then serves), then `orchestrator` starts.

### Post-deploy smoke checklist

- [ ] `https://waypoint.[MY_DOMAIN]` redirects to `/signin`; Google sign-in works
      for your allowlisted email; any other Google account is rejected.
- [ ] `https://waypoint.[MY_DOMAIN]/api/health` returns **404** (Caddy doesn't
      proxy it — internal only).
- [ ] Settings shows Claude token + GitHub PAT as **set**; "Refresh models"
      returns a model list.
- [ ] Send yourself a test: create a Project (a small repo), press **Verify**,
      and watch its log stream on the task page.
- [ ] Plan-approval email arrives for a real task; **replying** to it with
      revision notes updates the plan (inbound path working end-to-end).
- [ ] **Litestream restore drill** (do this once now — it restores to a _test
      file_, so nothing needs to stop):
  ```bash
  cd /opt/waypoint/deploy
  docker compose run --rm litestream \
    restore -config /etc/litestream.yml -o /data/restore-test.db /data/waypoint.db
  # confirm it exists, then clean up:
  docker compose run --rm --entrypoint sh litestream -c "ls -la /data/restore-test.db && rm /data/restore-test.db"
  ```

---

## 12. Per-project onboarding (repeat per client repo)

In the UI → Projects → New Project:

1. Fill in the https clone URL, setup/run/test commands, coverage format +
   report path, and the ready URL for the testing stage.
2. Add project secrets (env vars the app under test needs). They're injected
   into that project's task containers only.
3. If the repo needs a PAT different from the global one, add a `GIT_PAT`
   project secret.
4. Press **Verify** — a throwaway container clones, runs setup + tests, and
   streams the log. Iterate until green; then the project is trustworthy.
5. (Optional, custom runner image) If the project sets a Dockerfile path, build
   the image manually on the VPS — it must be `FROM waypoint-runner:latest`:
   ```bash
   docker build -t waypoint-project-<projectId> -f <path/to/Dockerfile> <repo>
   ```

### Waypoint working on itself (optional)

Register Waypoint as a project in its own DB like any repo:

- Repo URL: this repo · Setup: `bun install && bun run db:generate`
- Test: a test command that emits LCOV · Run: `bun run dev:web` with
  `AUTH_DEV_BYPASS=1` + `NODE_ENV=development` project secrets so the testing
  agent can click through without Google (dev-only code path).
- Deploying merged changes stays **manual by design**: SSH in and run
  `/opt/waypoint/deploy/deploy.sh`.

---

## 13. Local development (optional)

```bash
make run     # web + orchestrator, Ctrl-C stops both
make help    # every target
```

First run installs deps, generates the Prisma client, applies migrations, seeds,
and writes **`.env.local`** in the repo root (gitignored) with a fresh
`AUTH_SECRET` and `MASTER_ENCRYPTION_KEY`. That file is where local config
lives — fill in `CLAUDE_CODE_OAUTH_TOKEN` and `GITHUB_DEFAULT_PAT` to run real
tasks, and re-run `make db-seed` after adding them so they land as global
Secrets. Don't rotate `MASTER_ENCRYPTION_KEY` — it orphans every secret already
in `dev.db`.

Local wiring differs from prod in three places: `AUTH_DEV_BYPASS=1` skips Google
sign-in (dev-only code path), `DATABASE_URL` points at
`packages/core/prisma/dev.db`, and the task-data volume is the host dir
`.local/tasks`, bind-mounted into task containers so web, the orchestrator and
the runners all see the same files.

Tasks additionally need the runner image — `make runner-image` (slow: Playwright
base). `make doctor` reports what's missing.

---

## Quick reference — every `.env` value and where it comes from

| Var                                         | Source                                |
| ------------------------------------------- | ------------------------------------- |
| `APP_URL`, `AUTH_URL`                       | fixed: `https://waypoint.[MY_DOMAIN]` |
| `AUTH_SECRET`                               | step 9                                |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | step 6                                |
| `MASTER_ENCRYPTION_KEY`                     | step 9                                |
| `SEED_ALLOWED_EMAILS`                       | your email(s)                         |
| `RESEND_API_KEY`                            | step 5.1                              |
| `RESEND_WEBHOOK_SECRET`                     | step 5.4                              |
| `EMAIL_FROM`                                | `waypoint@waypoint.[MY_DOMAIN]`       |
| `INBOUND_DOMAIN`                            | `waypoint.[MY_DOMAIN]`                |
| `CLAUDE_CODE_OAUTH_TOKEN`                   | step 7.1 (`claude setup-token`)       |
| `ANTHROPIC_API_KEY`                         | step 7.2                              |
| `GITHUB_DEFAULT_PAT`                        | step 8                                |
| `GHCR_USER`                                 | your GitHub username                  |
| `LITESTREAM_*`                              | step 10                               |
