/**
 * Guess a project's commands from the files at the root of its repository:
 * the Makefile, compose files and package.json. Pure — the caller fetches the
 * files. Every guess is a starting point the user reviews in the project form.
 */

export interface DetectedCommands {
  setupCommand?: string;
  runCommand?: string;
  runReadyUrl?: string;
  migrateCommand?: string;
  testCommand?: string;
  lintCommand?: string;
  formatCommand?: string;
  /** The detected test command writes no coverage report, so coverage has to be off. */
  testWithoutCoverage?: boolean;
  /** The app or its tooling needs Docker inside the task container. */
  dockerEnabled: boolean;
  /** Things the user should know about what was, or wasn't, filled in. */
  notes: string[];
}

/** Root files worth fetching, in the order they're preferred. */
export const MAKEFILE_NAMES = ["Makefile", "makefile", "GNUmakefile"];
export const COMPOSE_NAMES = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
];
export const LOCKFILES: Record<string, string> = {
  "bun.lock": "bun",
  "bun.lockb": "bun",
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
  "package-lock.json": "npm",
};
export const DETECT_FILES = [...MAKEFILE_NAMES, ...COMPOSE_NAMES, "package.json"];

// Preferred target/script names per command, best first.
const SETUP = ["setup", "install", "bootstrap", "deps", "init"];
const RUN = ["run", "dev", "start", "up", "serve"];
const MIGRATE = ["migrate", "db-migrate", "db:migrate", "migrate-up", "db-push", "db:push"];
const COVERAGE = ["test-coverage", "test-cov", "coverage", "test:coverage", "test:cov", "cov"];
const LINT = ["lint"];
const FORMAT = ["format", "fmt"];
// Services a browser would open, best first.
const WEB_SERVICES = ["frontend", "web", "app", "ui", "client", "nginx", "proxy"];

/**
 * @param files root file name → content, for whichever of DETECT_FILES exist
 * @param rootNames every file name at the repository root (for lockfiles)
 */
export function detectCommands(
  files: Record<string, string>,
  rootNames: string[],
): DetectedCommands {
  const out: DetectedCommands = { dockerEnabled: false, notes: [] };
  const makefile = firstOf(files, MAKEFILE_NAMES);
  const composeName = COMPOSE_NAMES.find((n) => files[n] !== undefined);
  const compose = composeName ? files[composeName] : undefined;
  const pkg = parsePackageJson(files["package.json"]);

  if (makefile !== undefined) {
    const targets = makeTargets(makefile);
    const pick = (names: string[]) => names.find((n) => targets.has(n));
    out.setupCommand = make(pick(SETUP));
    out.runCommand = make(pick(RUN));
    out.migrateCommand = make(pick(MIGRATE));
    out.lintCommand = make(pick(LINT));
    out.formatCommand = make(pick(FORMAT));
    out.testCommand = make(pick(COVERAGE));
    if (!out.testCommand && targets.has("test")) {
      out.testCommand = "make test";
      out.testWithoutCoverage = true;
    }
    for (const field of ["setupCommand", "runCommand", "testCommand"] as const) {
      const target = out[field]?.slice("make ".length);
      if (target && /\bdocker\b/.test(expandVars(targets.get(target) ?? "", makefile))) {
        out.dockerEnabled = true;
      }
    }
  }

  if (pkg) {
    const pm = rootNames.map((n) => LOCKFILES[n]).find(Boolean) ?? "npm";
    const script = (names: string[]) => {
      const name = names.find((n) => pkg.scripts[n]);
      return name ? `${pm} run ${name}` : undefined;
    };
    out.setupCommand ??= `${pm} install`;
    out.runCommand ??= script(RUN);
    out.migrateCommand ??= script(MIGRATE);
    out.lintCommand ??= script(LINT);
    out.formatCommand ??= script(FORMAT);
    out.testCommand ??= script(COVERAGE);
    if (!out.testCommand && pkg.scripts.test) {
      out.testCommand = `${pm} run test`;
      out.testWithoutCoverage = true;
    }
  }

  if (out.testWithoutCoverage) {
    out.notes.push(
      `Found \`${out.testCommand}\` but no coverage target, so "Require test coverage" is switched off: the tests only have to pass.`,
    );
  }

  if (compose !== undefined) {
    out.dockerEnabled = true;
    out.runCommand ??= "docker compose up --build";
    out.setupCommand ??= "docker compose build";
    const url = composeReadyUrl(compose);
    if (url) out.runReadyUrl = url;
    out.notes.push(
      `Found ${composeName}, so Docker inside tasks is switched on. Env files the stack reads that aren't in the clone are written from this project's secrets, so add the variables it needs there.`,
    );
  } else if (out.dockerEnabled) {
    out.notes.push("The Makefile calls docker, so Docker inside tasks is switched on.");
  }

  if (!out.runReadyUrl && out.runCommand && pkg) {
    const port = pkg.deps.has("next") ? 3000 : pkg.deps.has("vite") ? 5173 : undefined;
    if (port) out.runReadyUrl = `http://localhost:${port}`;
  }

  if (makefile === undefined && !pkg && compose === undefined) {
    out.notes.push(
      "No Makefile, compose file or package.json at the repository root — nothing to go on.",
    );
  }
  return out;
}

const make = (target: string | undefined) => (target ? `make ${target}` : undefined);

const record = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, string>) : {});

function firstOf(files: Record<string, string>, names: string[]): string | undefined {
  for (const name of names) if (files[name] !== undefined) return files[name];
  return undefined;
}

/** Makefile targets → their recipe text. Pattern and special targets are skipped. */
export function makeTargets(makefile: string): Map<string, string> {
  const targets = new Map<string, string>();
  let current: string[] = [];
  for (const line of makefile.split(/\r?\n/)) {
    if (line.startsWith("\t")) {
      for (const name of current) targets.set(name, `${targets.get(name) ?? ""}${line}\n`);
      continue;
    }
    // `name other: deps` — but not `VAR := x`, `VAR ::= x` or `a: VAR = x`
    const rule = /^([A-Za-z0-9_][A-Za-z0-9_.\- ]*):(?![:=])([^=]*)$/.exec(line.split("#")[0] ?? "");
    if (!rule) {
      if (line.trim() && !line.startsWith("#")) current = [];
      continue;
    }
    current = (rule[1] ?? "").trim().split(/\s+/);
    for (const name of current) if (!targets.has(name)) targets.set(name, "");
  }
  return targets;
}

/** Substitute `$(VAR)` / `${VAR}` with the Makefile's own simple assignments. */
function expandVars(recipe: string, makefile: string): string {
  const vars = new Map<string, string>();
  for (const m of makefile.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)[ \t]*(?::{0,2}|\?)=[ \t]*(.*)$/gm)) {
    vars.set(m[1] ?? "", m[2] ?? "");
  }
  return recipe.replace(/\$[({]([A-Za-z_][A-Za-z0-9_]*)[)}]/g, (whole, name: string) =>
    vars.has(name) ? (vars.get(name) ?? "") : whole,
  );
}

interface PackageInfo {
  scripts: Record<string, string>;
  deps: Set<string>;
}

function parsePackageJson(text: string | undefined): PackageInfo | null {
  if (text === undefined) return null;
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    return {
      scripts: record(json.scripts),
      deps: new Set([
        ...Object.keys(record(json.dependencies)),
        ...Object.keys(record(json.devDependencies)),
      ]),
    };
  } catch {
    return null;
  }
}

/** Host ports each compose service publishes, in file order. */
export function composePorts(compose: string): Map<string, number[]> {
  const services = new Map<string, number[]>();
  let inServices = false;
  let serviceIndent = -1;
  let service: string | null = null;
  let portsIndent = -1;

  for (const raw of compose.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const text = line.trim();

    if (indent === 0) {
      inServices = text === "services:";
      service = null;
      serviceIndent = -1;
      continue;
    }
    if (!inServices) continue;
    if (serviceIndent === -1) serviceIndent = indent;
    if (indent === serviceIndent) {
      service = text.replace(/:$/, "");
      services.set(service, []);
      portsIndent = -1;
      continue;
    }
    if (!service) continue;
    if (text === "ports:") {
      portsIndent = indent;
      continue;
    }
    if (portsIndent === -1) continue;
    if (indent < portsIndent || (indent === portsIndent && !text.startsWith("-"))) {
      portsIndent = -1;
      continue;
    }
    // short form `- "8080:80"` / `- 127.0.0.1:8080:80/tcp`, long form `published: 8080`
    const short = /^-\s*["']?(?:[\d.]+:)?(\d+):\d+(?:\/\w+)?["']?$/.exec(text);
    const long = /^(?:-\s*)?published:\s*["']?(\d+)["']?$/.exec(text);
    const port = Number(short?.[1] ?? long?.[1]);
    if (port) services.get(service)?.push(port);
  }
  return services;
}

function composeReadyUrl(compose: string): string | undefined {
  const ports = composePorts(compose);
  const published = [...ports].filter(([, p]) => p.length > 0);
  const preferred = WEB_SERVICES.map((name) => published.find(([s]) => s === name)).find(Boolean);
  const port = (preferred ?? published[0])?.[1][0];
  if (!port) return undefined;
  return port === 80 ? "http://localhost" : `http://localhost:${port}`;
}
