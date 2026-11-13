# Waypoint runner image (§6): Playwright base (Chromium preinstalled) + Node 24
# + Bun + uv + pnpm/yarn + Docker + git + diff-cover + gcov2lcov + the runner program.
# Projects may substitute their own Dockerfile — it must FROM waypoint-runner:latest.
#
# Build from the REPO ROOT:  docker build -f apps/runner/Dockerfile -t waypoint-runner:latest .
FROM mcr.microsoft.com/playwright:v1.62.1-noble

# Node 24 (the Playwright image ships an older Node) + the standard unix toolchain
# projects' build/test scripts expect (make, compilers, archivers, text tools).
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl git gnupg \
    build-essential pkg-config \
    python3 pipx golang-go \
    unzip zip xz-utils bzip2 tar gzip \
    jq less file tree rsync openssh-client procps psmisc \
    gawk sed grep findutils diffutils patch which vim-tiny \
  && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

# Bun — all dependency management & scripts run through Bun (§1)
RUN curl -fsSL https://bun.sh/install | bash \
  && ln -s /root/.bun/bin/bun /usr/local/bin/bun \
  && ln -s /root/.bun/bin/bunx /usr/local/bin/bunx

# Package managers the cloned projects' own setup commands call for.
# uv: Python projects (`uv sync`); it downloads whichever Python the project
# pins, so the image doesn't have to carry every version.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/
# Task workspaces sit on a volume, a different filesystem from uv's cache, so
# hardlinking can't work — copy instead of warning on every install.
ENV UV_LINK_MODE=copy
# pnpm + yarn: corepack shims that fetch the version a project's
# `packageManager` field pins, without stopping to ask first.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable pnpm yarn

# Docker Engine + Compose, for projects whose app runs as a compose stack
# (database + backend + frontend). Installed in every image but only started
# for projects that opt in: the orchestrator sets RUNNER_DOCKER=1 and gives the
# container the privileges a nested daemon needs (see src/dockerd.ts).
RUN install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" \
    > /etc/apt/sources.list.d/docker.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin iptables \
  && rm -rf /var/lib/apt/lists/*
# `dind` prepares cgroups and mounts for a daemon nested inside a container.
COPY --from=docker:dind /usr/local/bin/dind /usr/local/bin/dind
# Keeps the nested daemon's networks off 172.16.0.0/12, where the host's own
# Docker networks live — a clash would cut the runner off from the web app.
COPY apps/runner/docker/daemon.json /etc/docker/daemon.json

# diff-cover (accepts Cobertura/Clover/JaCoCo XML + LCOV) and gcov2lcov (Go)
ENV PIPX_BIN_DIR=/usr/local/bin
RUN pipx install diff-cover
RUN GOBIN=/usr/local/bin go install github.com/jandelgado/gcov2lcov@latest && rm -rf /root/go /root/.cache/go-build

WORKDIR /app
COPY apps/runner/package.json ./package.json
RUN bun install --production && bun pm trust --all || true
COPY apps/runner/src ./src
COPY apps/runner/prompts ./prompts
COPY apps/runner/tsconfig.json ./tsconfig.json
# tsconfig extends ../../tsconfig.base.json — from /app that resolves to /
COPY tsconfig.base.json /tsconfig.base.json

ENV NODE_ENV=production
# The agent runs as root in a throwaway container and skips permission prompts;
# without this the CLI refuses (`--dangerously-skip-permissions cannot be used
# with root/sudo privileges`). The container itself is the sandbox (§11).
ENV IS_SANDBOX=1
RUN mkdir -p /workspace
WORKDIR /workspace
# tsx runs on the Node 24 runtime (better-sqlite3-free image; §1 runtime note)
ENTRYPOINT ["/app/node_modules/.bin/tsx", "/app/src/index.ts"]
