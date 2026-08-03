# Waypoint — local development.
#
#   make run     start everything (web + orchestrator), ready for local dev
#   make help    list every target
#
# `make run` is idempotent: it installs deps, generates the Prisma client,
# applies migrations, seeds, prepares the local task-data dir + Docker network,
# then runs web and the orchestrator together. Ctrl-C stops both.

SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c
.ONESHELL:
.DEFAULT_GOAL := help

ROOT       := $(patsubst %/,%,$(dir $(abspath $(lastword $(MAKEFILE_LIST)))))
ENV_FILE   := $(ROOT)/.env.local
STAMPS     := $(ROOT)/.make
DB_FILE    := $(ROOT)/packages/core/prisma/dev.db
GENERATED  := $(ROOT)/packages/core/src/generated/prisma
MIGRATIONS := $(wildcard $(ROOT)/packages/core/prisma/migrations/*/migration.sql)
MANIFESTS  := $(ROOT)/package.json $(ROOT)/bun.lock $(wildcard $(ROOT)/apps/*/package.json) $(wildcard $(ROOT)/packages/*/package.json)

# Overridable knobs:  make run WEB_PORT=3001
WEB_PORT      ?= 3000
RUNNER_IMAGE  ?= waypoint-runner:latest
TASKS_NETWORK ?= waypoint-tasks

# Task transcripts/artifacts. In prod this is a named volume shared by web,
# orchestrator and the task containers; locally it's one host dir bind-mounted
# into the containers, so all three see the same files.
TASK_DATA := $(ROOT)/.local/tasks

# Exported to every recipe (and therefore to web, the orchestrator and the
# Prisma CLI). Everything else lives in .env.local.
export DATABASE_URL     := file:$(DB_FILE)
export TASK_DATA_DIR    := $(TASK_DATA)
export TASK_DATA_VOLUME := $(TASK_DATA)
export RUNNER_IMAGE
export TASKS_NETWORK
export PORT     := $(WEB_PORT)

# .env.local into the recipe's environment
define load_env
set -a; source $(ENV_FILE); set +a
endef

.PHONY: help run setup deps prisma db-migrate db-migrate-dev db-seed db-reset \
        db-studio runner-image typecheck lint lint-fix format format-check \
        check build doctor clean clean-tasks clean-db

## help: list targets
help:
	@echo "Waypoint — local development"
	@echo
	@grep -E '^## ' $(MAKEFILE_LIST) | \
	  awk '{ l = substr($$0, 4); i = index(l, ": "); printf "  make %-16s %s\n", substr(l, 1, i - 1), substr(l, i + 2) }'
	@echo
	@echo "  Knobs: WEB_PORT=$(WEB_PORT) RUNNER_IMAGE=$(RUNNER_IMAGE) AUTH_DEV_BYPASS=$(AUTH_DEV_BYPASS)"

# ---------------------------------------------------------------- run --------

## run: start web + orchestrator for local dev (Ctrl-C stops both)
run: setup
	@$(load_env)
	# Runners reach web from inside a container: the bridge gateway on Linux,
	# host.docker.internal on macOS.
	if [[ "$$(uname -s)" == "Darwin" ]]; then
	  export RUNNER_HOST_API="http://host.docker.internal:$(WEB_PORT)"
	else
	  gw=$$(docker network inspect $(TASKS_NETWORK) -f '{{ (index .IPAM.Config 0).Gateway }}' 2>/dev/null || true)
	  export RUNNER_HOST_API="http://$${gw:-172.17.0.1}:$(WEB_PORT)"
	fi
	if ! docker image inspect $(RUNNER_IMAGE) >/dev/null 2>&1; then
	  echo "  ! $(RUNNER_IMAGE) is missing — tasks can't start until you run 'make runner-image'"
	fi
	echo
	if [[ "$$AUTH_DEV_BYPASS" == "1" ]]; then
	  auth="AUTH_DEV_BYPASS — no Google sign-in"
	else
	  auth="Google sign-in (AUTH_DEV_BYPASS=$$AUTH_DEV_BYPASS)"
	fi
	echo "  web           http://localhost:$(WEB_PORT)   ($$auth)"
	echo "  orchestrator  tick every 15s, runners on $$RUNNER_HOST_API"
	echo "  database      $(DB_FILE)"
	echo "  task data     $(TASK_DATA)"
	echo
	# Tear both down together — bun forwards SIGTERM, and pkill -P catches the
	# next/tsx child it spawned via shebang. Output goes through process
	# substitution (not a pipe) so $$! is bun's pid rather than sed's.
	pids=()
	stop() {
	  trap - INT TERM
	  for pid in "$${pids[@]}"; do
	    pkill -TERM -P $$pid 2>/dev/null || true
	    kill -TERM $$pid 2>/dev/null || true
	  done
	  wait 2>/dev/null || true
	}
	trap 'echo; echo "  stopping…"; stop; exit 0' INT TERM
	bun run --cwd apps/web dev          > >(sed -u 's/^/[web]  /') 2>&1 & pids+=($$!)
	bun run --cwd apps/orchestrator dev > >(sed -u 's/^/[orch] /') 2>&1 & pids+=($$!)
	set +e
	wait -n
	code=$$?
	echo
	echo "  a process exited (status $$code) — stopping the other"
	stop
	exit $$code

## setup: install deps, generate client, migrate, seed, prepare dirs (run does this)
# preflight first: a leftover dev server holds both the port and the SQLite lock,
# which would otherwise surface as a cryptic "database is locked" from Prisma.
setup: preflight deps prisma $(DB_FILE) $(STAMPS)/seed task-dir docker-net

# ---------------------------------------------------------------- setup ------

$(STAMPS) $(TASK_DATA):
	@mkdir -p $@

## deps: bun install
deps: $(STAMPS)/deps
$(STAMPS)/deps: $(MANIFESTS) | $(STAMPS)
	@echo "==> bun install"
	bun install
	@touch $@

## prisma: generate the Prisma client
prisma: $(STAMPS)/prisma
$(STAMPS)/prisma: $(ROOT)/packages/core/prisma/schema.prisma $(STAMPS)/deps | $(STAMPS)
	@echo "==> prisma generate"
	bun run db:generate
	@touch $@

# The db file IS the target: delete it and the next `make run` rebuilds it.
$(DB_FILE): $(MIGRATIONS) $(STAMPS)/prisma
	@echo "==> prisma migrate deploy"
	bun run db:migrate:deploy
	@touch $@

$(STAMPS)/seed: $(ENV_FILE) $(DB_FILE) | $(STAMPS)
	@echo "==> seed (settings, allowlist, global secrets)"
	$(load_env)
	bun run db:seed
	@touch $@

# Task containers run as root and create /data/tasks/{taskId} themselves; the
# default ACL keeps those dirs writable by you, so web can still drop artifacts
# (plan.md, pr.md) alongside the runner's transcripts.
.PHONY: task-dir
task-dir: | $(TASK_DATA)
	@if command -v setfacl >/dev/null 2>&1; then
	  setfacl -R -m u:$$(id -u):rwx -m d:u:$$(id -u):rwx $(TASK_DATA) 2>/dev/null || true
	else
	  echo "  ! setfacl not found — artifacts may hit permission errors under $(TASK_DATA)"
	  echo "    (install 'acl', or chown -R \$$USER $(TASK_DATA) if writes fail)"
	fi

.PHONY: docker-net
docker-net:
	@if ! docker info >/dev/null 2>&1; then
	  echo "  ! Docker isn't reachable — web still runs, but the orchestrator can't start tasks"
	  exit 0
	fi
	docker network inspect $(TASKS_NETWORK) >/dev/null 2>&1 || \
	  docker network create $(TASKS_NETWORK) >/dev/null

.PHONY: preflight
preflight:
	@if ss -ltn "sport = :$(WEB_PORT)" 2>/dev/null | grep -q LISTEN; then
	  echo "  ! port $(WEB_PORT) is already in use:"
	  ss -ltnp "sport = :$(WEB_PORT)" 2>/dev/null | tail -n +2 || true
	  echo "    stop that process — 'next dev' also refuses to start a second"
	  echo "    server for this directory, so WEB_PORT won't get you around it."
	  exit 1
	fi
	# a second process on dev.db makes `prisma migrate` fail with "database is locked"
	holders=$$(fuser $(DB_FILE) 2>/dev/null | tr -s ' ' || true)
	if [[ -n "$${holders// /}" ]]; then
	  echo "  ! another process has $(DB_FILE) open:"
	  ps -o pid,args -p $$holders 2>/dev/null | tail -n +2 || true
	  echo "    that's probably a leftover 'make run' — stop it first"
	  exit 1
	fi

# Generated once and never regenerated — rotating MASTER_ENCRYPTION_KEY orphans
# every stored secret.
$(ENV_FILE):
	@echo "==> creating .env.local (gitignored)"
	cat > $(ENV_FILE) <<-EOF
		# Waypoint local dev — created by \`make setup\`, never committed.
		# WARNING: changing MASTER_ENCRYPTION_KEY orphans every secret already
		# stored in dev.db (they'd need re-entering in Settings).
		APP_URL=http://localhost:$(WEB_PORT)
		AUTH_URL=http://localhost:$(WEB_PORT)/api/auth
		AUTH_SECRET=$$(openssl rand -base64 32)
		MASTER_ENCRYPTION_KEY=$$(openssl rand -hex 32)
		# skips Google sign-in; only honored when NODE_ENV=development
		AUTH_DEV_BYPASS=1
		SEED_ALLOWED_EMAILS=ericghildyal@gmail.com

		# --- optional: fill in to exercise the full pipeline ------------------
		# \`claude setup-token\` — seeds the global CLAUDE_CODE_OAUTH_TOKEN secret
		CLAUDE_CODE_OAUTH_TOKEN=
		# only used by Settings → "Refresh models". NOT named ANTHROPIC_API_KEY
		# so the Claude Code SDK doesn't pick it up and bill agent runs to it
		# instead of the Max subscription OAuth token above.
		MODEL_LOOKUP_ANTHROPIC_API_KEY=
		# seeds the global GIT_PAT secret (clone/push/PR on your repos)
		GITHUB_DEFAULT_PAT=
		# leave empty to disable outbound email locally
		RESEND_API_KEY=
		RESEND_WEBHOOK_SECRET=
		EMAIL_FROM=waypoint@localhost
		INBOUND_DOMAIN=localhost
	EOF
	@chmod 600 $(ENV_FILE)
	@echo "    fill in CLAUDE_CODE_OAUTH_TOKEN + GITHUB_DEFAULT_PAT to run real tasks"

# ---------------------------------------------------------------- db ---------

## db-migrate: apply committed migrations
db-migrate: $(STAMPS)/prisma
	bun run db:migrate:deploy

## db-migrate-dev: create a migration after editing schema.prisma (interactive)
db-migrate-dev: $(STAMPS)/prisma
	bun run db:migrate:dev
	@rm -f $(STAMPS)/prisma

## db-seed: re-run the idempotent seed
db-seed: $(ENV_FILE)
	$(load_env)
	bun run db:seed
	@touch $(STAMPS)/seed

## db-studio: browse dev.db in Prisma Studio
db-studio: $(STAMPS)/prisma
	cd $(ROOT)/packages/core && bunx prisma studio

## db-reset: delete dev.db and rebuild it from migrations + seed
db-reset:
	rm -f $(DB_FILE) $(DB_FILE)-wal $(DB_FILE)-shm $(STAMPS)/seed
	@$(MAKE) --no-print-directory $(DB_FILE) $(STAMPS)/seed

# ---------------------------------------------------------------- misc -------

## runner-image: build waypoint-runner:latest (slow — Playwright base)
runner-image:
	docker build -f $(ROOT)/apps/runner/Dockerfile -t $(RUNNER_IMAGE) $(ROOT)

## typecheck: tsc --noEmit across every workspace
typecheck: $(STAMPS)/prisma
	bun run typecheck

# ---------------------------------------------------------------- checks -----
#
# oxlint is the linter, prettier the formatter, and they don't overlap: oxlint
# has no opinion on layout, so `make format` never undoes what `make lint-fix`
# did. Neither needs the Prisma client, so both skip that dependency and stay
# fast — the whole repo lints in well under a second.

## lint: oxlint over every workspace
lint: $(STAMPS)/deps
	bun run lint

## lint-fix: oxlint --fix — apply the autofixable subset
lint-fix: $(STAMPS)/deps
	bun run lint:fix

## format: rewrite every file with prettier
format: $(STAMPS)/deps
	bun run format

## format-check: fail if anything is unformatted (what CI runs)
format-check: $(STAMPS)/deps
	bun run format:check

## check: typecheck + lint + format-check — the whole gate, same as CI
check: typecheck lint format-check
	@echo "  all checks passed"

## build: production build of the web app
# NODE_ENV is 'development' for every other target; `next build` must run with
# 'production' or it bundles dev React for the client while the prerender worker
# uses the production build — two React instances, and any client component that
# prerenders dies on "Cannot read properties of null (reading 'useContext')".
build: $(STAMPS)/prisma
	$(load_env)
	# after load_env, not before: .env.local carries NODE_ENV=development too,
	# and `set -a; source` would overwrite a target-specific value.
	export NODE_ENV=production
	bun run build:web

## doctor: check the local toolchain and what's running
doctor:
	@echo "bun          $$(bun --version 2>/dev/null || echo 'MISSING — https://bun.sh')"
	echo "node         $$(node --version 2>/dev/null || echo MISSING)"
	echo "docker       $$(docker info >/dev/null 2>&1 && docker --version || echo 'not reachable')"
	echo "runner image $$(docker image inspect $(RUNNER_IMAGE) --format '{{.Id}}' 2>/dev/null | cut -c8-19 || echo 'missing — make runner-image')"
	echo "setfacl      $$(command -v setfacl 2>/dev/null || echo 'missing (package: acl)')"
	echo ".env.local   $$([[ -f $(ENV_FILE) ]] && echo present || echo 'missing — make setup')"
	echo "dev.db       $$([[ -f $(DB_FILE) ]] && du -h $(DB_FILE) | cut -f1 || echo 'missing — make setup')"
	echo "port $(WEB_PORT)    $$(ss -ltn "sport = :$(WEB_PORT)" 2>/dev/null | grep -q LISTEN && echo 'IN USE' || echo free)"
	echo "task cts     $$(docker ps -q --filter label=waypoint.task 2>/dev/null | wc -l) running"

## clean-tasks: force-remove leftover task containers and their volumes
clean-tasks:
	@docker ps -aq --filter label=waypoint.task | xargs -r docker rm -f
	docker volume ls -q --filter label=waypoint.volume=task | xargs -r docker volume rm -f
	@echo "removed task containers + workspace volumes"

## clean-db: alias for db-reset
clean-db: db-reset

## clean: drop build output, stamps and node_modules (keeps .env.local + dev.db)
clean:
	rm -rf $(STAMPS) $(ROOT)/apps/web/.next $(ROOT)/node_modules \
	       $(ROOT)/apps/*/node_modules $(ROOT)/packages/*/node_modules
	@echo "run 'make run' to rebuild"
