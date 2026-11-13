import { describe, expect, test } from "bun:test";
import { composePorts, detectCommands, makeTargets } from "./detect-commands";

const MAKEFILE = `
COMPOSE  := docker compose
UV ?= uv
.PHONY: install run lint

install: ## deps
\tcd backend && $(UV) sync

run: ## start the stack
\t$(COMPOSE) up

lint: lint-backend lint-frontend
lint-backend:
\tcd backend && $(UV) run ruff check .

format fmt:
\truff format .

test:
\tdocker compose -f docker-compose-test.yaml run --rm test

migrate: db-up
\talembic upgrade head
`;

const COMPOSE = `
name: demo
services:
  db:
    image: postgres:18-alpine
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql
  backend:
    build: ./backend
    ports:
      - "8000:8000"
  frontend:
    build: ./frontend
    ports:
      # host port 80
      - "80:3000"
    environment:
      API_URL: http://backend:8000
volumes:
  pgdata:
`;

describe("makeTargets", () => {
  test("finds rule names and skips variable assignments and special targets", () => {
    const targets = makeTargets(MAKEFILE);
    expect([...targets.keys()]).toEqual([
      "install",
      "run",
      "lint",
      "lint-backend",
      "format",
      "fmt",
      "test",
      "migrate",
    ]);
    expect(targets.get("run")).toContain("$(COMPOSE) up");
  });
});

describe("composePorts", () => {
  test("reads the host side of each service's published ports", () => {
    expect(Object.fromEntries(composePorts(COMPOSE))).toEqual({
      db: [5432],
      backend: [8000],
      frontend: [80],
    });
  });

  test("understands bound addresses, protocols and the long form", () => {
    const ports = composePorts(
      `services:\n  api:\n    ports:\n      - 127.0.0.1:8080:80/tcp\n      - target: 443\n        published: "8443"\n`,
    );
    expect(ports.get("api")).toEqual([8080, 8443]);
  });
});

describe("detectCommands", () => {
  test("a Makefile and a compose file: make targets, the frontend's port, Docker on", () => {
    const found = detectCommands({ Makefile: MAKEFILE, "docker-compose.yml": COMPOSE }, []);
    expect(found).toMatchObject({
      setupCommand: "make install",
      runCommand: "make run",
      runReadyUrl: "http://localhost",
      migrateCommand: "make migrate",
      lintCommand: "make lint",
      formatCommand: "make format",
      dockerEnabled: true,
    });
  });

  test("a plain `make test` is offered with coverage switched off", () => {
    const found = detectCommands({ Makefile: MAKEFILE }, []);
    expect(found.testCommand).toBe("make test");
    expect(found.testWithoutCoverage).toBe(true);
    expect(found.notes.join(" ")).toContain("make test");
  });

  test("a compose file alone runs the stack directly", () => {
    const found = detectCommands({ "compose.yaml": COMPOSE }, []);
    expect(found).toMatchObject({
      setupCommand: "docker compose build",
      runCommand: "docker compose up --build",
      dockerEnabled: true,
    });
  });

  test("package.json scripts use the lockfile's package manager", () => {
    const pkg = JSON.stringify({
      scripts: { dev: "next dev", lint: "oxlint", "test:coverage": "bun test --coverage" },
      dependencies: { next: "16" },
    });
    const found = detectCommands({ "package.json": pkg }, ["package.json", "pnpm-lock.yaml"]);
    expect(found).toMatchObject({
      setupCommand: "pnpm install",
      runCommand: "pnpm run dev",
      runReadyUrl: "http://localhost:3000",
      lintCommand: "pnpm run lint",
      testCommand: "pnpm run test:coverage",
      dockerEnabled: false,
    });
  });

  test("docker reached through a Makefile variable still switches Docker on", () => {
    expect(detectCommands({ Makefile: MAKEFILE }, []).dockerEnabled).toBe(true);
  });

  test("a Makefile that never touches docker leaves Docker off", () => {
    const found = detectCommands({ Makefile: "setup:\n\tbun install\ndev:\n\tbun dev\n" }, []);
    expect(found).toMatchObject({ setupCommand: "make setup", runCommand: "make dev" });
    expect(found.dockerEnabled).toBe(false);
  });

  test("an empty repository says there was nothing to go on", () => {
    expect(detectCommands({}, ["README.md"]).notes).toHaveLength(1);
  });
});
