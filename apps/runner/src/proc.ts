import { type SpawnOptions, spawn } from "node:child_process";

export interface RunResult {
  code: number;
  output: string; // interleaved stdout+stderr
}

/** Run a shell command, capturing interleaved output (with a byte cap). */
export function run(
  command: string,
  opts: {
    cwd: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    onLine?: (line: string) => void;
  },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", command], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    const append = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output = (output + text).slice(-200_000);
      if (opts.onLine) {
        for (const line of text.split("\n")) {
          if (line.trim()) opts.onLine(line);
        }
      }
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);

    const timeout = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : null;

    // a failed spawn emits BOTH "error" and "close" — first one wins
    let settled = false;
    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      finish({ code: code ?? 1, output });
    });
    child.on("error", (err) => {
      if (timeout) clearTimeout(timeout);
      finish({ code: 127, output: output + String(err) });
    });
  });
}

/** Spawn a long-lived process (the app under test) in its own process group. */
export function spawnDetached(
  command: string,
  opts: { cwd: string; onLine?: (line: string) => void },
): { kill: () => void; output: () => string } {
  const child = spawn("bash", ["-lc", command], {
    cwd: opts.cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  } satisfies SpawnOptions);

  let output = "";
  const append = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    output = (output + text).slice(-100_000);
    if (opts.onLine) {
      for (const line of text.split("\n")) if (line.trim()) opts.onLine(line);
    }
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);

  return {
    kill: () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGTERM");
      } catch {
        /* already dead */
      }
    },
    output: () => output,
  };
}

export const tail = (text: string, chars = 2000): string =>
  text.length > chars ? text.slice(-chars) : text;
