import { promises as fs } from "node:fs";
import path from "node:path";
import type { RunnerConfig } from "./config";
import { dockerEnabled } from "./dockerd";
import type { Syncer } from "./sync";

/** Compose files read at the root of the workspace. */
const COMPOSE_FILE = /^(docker-)?compose([.-][\w.-]+)?\.ya?ml$/;
/** Our record of the env files we wrote, so a later start refreshes them. */
const MANIFEST = ".waypoint/env-files.json";

/**
 * Give a compose stack the project's secrets. Containers started by compose
 * don't inherit this container's environment; they read `env_file`s, which are
 * normally gitignored and so missing from a fresh clone — compose then refuses
 * to start. Every env file a root compose file names that the repository
 * doesn't provide is written here with the project's secrets.
 *
 * Runs on every start: a container recreated after a secret was rotated gets
 * fresh files, while files the repository itself tracks are never touched.
 */
export async function writeComposeEnvFiles(config: RunnerConfig, sync: Syncer): Promise<void> {
  if (!dockerEnabled()) return;
  const ws = config.workspace;
  const keys = (process.env.PROJECT_SECRET_KEYS ?? "").split(",").filter(Boolean);

  const names = (await fs.readdir(ws)).filter((n) => COMPOSE_FILE.test(n));
  const wanted = new Set<string>();
  for (const name of names) {
    const text = await fs.readFile(path.join(ws, name), "utf8").catch(() => "");
    for (const file of composeEnvFiles(text)) {
      const resolved = path.resolve(ws, file);
      // stay inside the workspace — a compose file can name any path
      if (resolved.startsWith(`${ws}${path.sep}`)) wanted.add(path.relative(ws, resolved));
    }
  }

  const ours = new Set(await readManifest(ws));
  const written: string[] = [];
  const body = keys.map((key) => `${key}=${envValue(process.env[key] ?? "")}\n`).join("");
  for (const file of wanted) {
    const target = path.join(ws, file);
    if (!ours.has(file) && (await exists(target))) continue; // the repository's own
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, body, { mode: 0o600 });
    written.push(file);
  }
  if (written.length === 0) return;

  await fs.mkdir(path.join(ws, ".waypoint"), { recursive: true });
  await fs.writeFile(path.join(ws, MANIFEST), JSON.stringify(written));
  await excludeFromGit(ws, written);
  sync.log(
    "info",
    keys.length
      ? `wrote ${keys.length} project secret(s) to ${written.join(", ")} for docker compose`
      : `created empty ${written.join(", ")} for docker compose — the project has no secrets`,
  );
}

/** Paths named by `env_file` anywhere in a compose file. */
export function composeEnvFiles(compose: string): string[] {
  const files: string[] = [];
  let listIndent = -1;
  for (const raw of compose.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const text = line.trim();

    const key = /^env_file:\s*(.*)$/.exec(text);
    if (key) {
      const inline = key[1] ?? "";
      if (inline.startsWith("[")) {
        for (const item of inline.replace(/^\[|\]$/g, "").split(",")) push(files, item);
        listIndent = -1;
      } else if (inline) {
        push(files, inline);
        listIndent = -1;
      } else {
        listIndent = indent;
      }
      continue;
    }
    if (listIndent === -1) continue;
    if (indent < listIndent || (indent === listIndent && !text.startsWith("-"))) {
      listIndent = -1;
      continue;
    }
    // `- ./a.env`, `- path: ./a.env`, or the `path:` line of a long-form entry
    const entry = /^(?:-\s*)?(?:path:\s*)?(.+)$/.exec(text)?.[1] ?? "";
    if (/^(?:-\s*)?(required|format):/.test(text)) continue;
    push(files, entry);
  }
  return [...new Set(files)];
}

function push(files: string[], raw: string): void {
  const value = raw.trim().replace(/^["']|["']$/g, "");
  // a path built from a variable can't be resolved here
  if (value && !value.includes("$")) files.push(value);
}

/** One value in the env-file syntax compose and dotenv both read. */
export function envValue(value: string): string {
  if (/^[\w.:/@+=,-]*$/.test(value)) return value;
  if (!value.includes("'") && !value.includes("\n")) return `'${value}'`;
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/\n/g, "\\n");
  return `"${escaped}"`;
}

async function readManifest(ws: string): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(ws, MANIFEST), "utf8"));
    return Array.isArray(parsed) ? parsed.filter((p) => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/** Secrets must never reach a commit, whatever the repository's .gitignore says. */
async function excludeFromGit(ws: string, files: string[]): Promise<void> {
  const exclude = path.join(ws, ".git/info/exclude");
  const current = await fs.readFile(exclude, "utf8").catch(() => "");
  const lines = new Set(current.split("\n"));
  const missing = files.map((f) => `/${f}`).filter((line) => !lines.has(line));
  if (missing.length) await fs.appendFile(exclude, `${missing.join("\n")}\n`);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
