# Waypoint runner image (§6): Playwright base (Chromium preinstalled) + Node 24
# + Bun + git + diff-cover + gcov2lcov + the runner program.
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
RUN mkdir -p /workspace
WORKDIR /workspace
# tsx runs on the Node 24 runtime (better-sqlite3-free image; §1 runtime note)
ENTRYPOINT ["/app/node_modules/.bin/tsx", "/app/src/index.ts"]
