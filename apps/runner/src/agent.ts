import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import {
  type Options,
  type PermissionResult,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKUserMessage,
  createSdkMcpServer,
  query,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { ChecklistTracker, TRACKED_TOOLS, clearChecklistTracker } from "./checklist";
import type { RunnerConfig } from "./config";
import type { StateStore } from "./state";
import { StopRequested, type Syncer, sleep } from "./sync";
import type { StageName, UsageTotals } from "./types";

export class RateLimited extends Error {
  constructor(public readonly resetsAt: string) {
    super(`rate limited until ${resetsAt}`);
  }
}

export class AgentError extends Error {}

/** Streaming input queue — enables mid-run steering injection + interrupt() (§6). */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private waiter: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  private ended = false;

  push(text: string): void {
    if (this.ended) return;
    const msg: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
      parent_tool_use_id: null,
    };
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: msg, done: false });
    } else {
      this.queue.push(msg);
    }
  }

  end(): void {
    this.ended = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const queued = this.queue.shift();
        if (queued) return Promise.resolve({ value: queued, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true as const });
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
    };
  }
}

export interface StageRunOptions {
  stage: StageName;
  attempt: number;
  model: string;
  initialPrompt: string;
  /** resume this Agent SDK session (implementation fix-up rounds, restarts) */
  resumeSessionId?: string;
  /** attach the Playwright MCP server (testing stage only, §6) */
  playwright?: boolean;
  /**
   * Called after each completed turn. Return a follow-up message to continue
   * the SAME query (coverage-gate loops, artifact nudges), or null to finish.
   */
  onTurnComplete?: () => Promise<string | null>;
}

export interface StageRunResult {
  sessionId: string | undefined;
}

const ZERO: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

/**
 * Execute one stage attempt (§6 SDK invocation pattern): streaming input,
 * permissions bypassed inside the sandbox container, in-process waypoint MCP
 * (ask_user), task-list→checklist hook, transcript JSONL, usage sync, steering,
 * pause via interrupt() + session resume, rate-limit reporting.
 */
export async function runStageAgent(
  config: RunnerConfig,
  sync: Syncer,
  state: StateStore,
  opts: StageRunOptions,
): Promise<StageRunResult> {
  const stageRunRef = `${opts.stage}:${opts.attempt}`;
  const transcriptFile = path.join(
    config.taskDataDir,
    `${opts.stage.toLowerCase()}-${opts.attempt}.jsonl`,
  );
  mkdirSync(path.dirname(transcriptFile), { recursive: true });

  // A fresh session starts a fresh task list, so one stage's items don't leak
  // into the next. Fix-up rounds resume a session and keep the list they built.
  if (!opts.resumeSessionId) clearChecklistTracker(state);

  let sessionId = opts.resumeSessionId;
  let prompt = opts.initialPrompt;

  for (;;) {
    const outcome = await executeQuery(config, sync, state, opts, {
      stageRunRef,
      transcriptFile,
      sessionId,
      prompt,
    });
    sessionId = outcome.sessionId ?? sessionId;

    if (outcome.kind === "finished") return { sessionId };
    if (outcome.kind === "stopped") throw new StopRequested();

    if (outcome.kind === "rate-limited") {
      sync.log("warn", `rate limited — resumes at ${outcome.resetsAt}`, stageRunRef);
      await sync.reportRateLimit(outcome.resetsAt);
    }
    // paused or rate-limited: wait for the host to flip control back to run,
    // then resume the same session (nothing lost, §5)
    await sync.waitForRun();
    prompt =
      "Continue where you left off. If you were interrupted mid-task, pick the work back up from the last completed step.";
  }
}

type QueryOutcome =
  | { kind: "finished"; sessionId?: string }
  | { kind: "paused"; sessionId?: string }
  | { kind: "stopped"; sessionId?: string }
  | { kind: "rate-limited"; resetsAt: string; sessionId?: string };

async function executeQuery(
  config: RunnerConfig,
  sync: Syncer,
  state: StateStore,
  opts: StageRunOptions,
  run: { stageRunRef: string; transcriptFile: string; sessionId?: string; prompt: string },
): Promise<QueryOutcome> {
  const input = new InputQueue();
  input.push(run.prompt);

  const waypointServer = createSdkMcpServer({
    name: "waypoint",
    version: "1.0.0",
    tools: [
      tool(
        "ask_user",
        [
          "Ask the user a question and wait for their answer.",
          "Asking a question costs seconds; a wrong direction costs the user's precious tokens.",
          "When uncertain about intent, scope, tradeoffs, or data, ask.",
        ].join(" "),
        {
          question: z.string().describe("The full question for the user"),
          contextSummary: z
            .string()
            .describe("1-3 sentence high-level context — this is what goes in the email"),
          options: z.array(z.string()).optional().describe("Optional multiple-choice options"),
        },
        async (args) => {
          sync.log("info", `❓ ask_user: ${args.question.slice(0, 200)}`, run.stageRunRef);
          const answer = await sync.ask({
            kind: "QUESTION",
            text: args.question,
            contextSummary: args.contextSummary,
            options: args.options,
          });
          return { content: [{ type: "text", text: answer }] };
        },
      ),
    ],
  });

  // reloads its entries from the durable state, so this stays correct across
  // the pause/resume loop and container restarts alike
  const checklist = new ChecklistTracker(state);

  const usageBase = { ...ZERO, ...readUsageBase(state, run.stageRunRef) };
  const current: UsageTotals = { ...ZERO };
  const pushUsage = () => {
    sync.setUsage({
      stageRunId: run.stageRunRef,
      inputTokens: usageBase.inputTokens + current.inputTokens,
      outputTokens: usageBase.outputTokens + current.outputTokens,
      cacheReadTokens: usageBase.cacheReadTokens + current.cacheReadTokens,
      cacheCreationTokens: usageBase.cacheCreationTokens + current.cacheCreationTokens,
    });
  };

  const options: Options = {
    model: opts.model,
    cwd: config.workspace,
    ...(run.sessionId ? { resume: run.sessionId } : {}),
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    // belt and braces for anything the SDK still routes through a prompt
    canUseTool: async (_tool, toolInput): Promise<PermissionResult> => ({
      behavior: "allow",
      updatedInput: toolInput,
    }),
    mcpServers: {
      waypoint: waypointServer,
      ...(opts.playwright
        ? {
            playwright: {
              type: "stdio" as const,
              command: "npx",
              // --no-sandbox: Chromium's own sandbox needs privileges Docker's
              // default profile withholds — the container is the boundary (§11)
              args: ["@playwright/mcp", "--headless", "--isolated", "--no-sandbox"],
            },
          }
        : {}),
    },
    hooks: {
      // No matcher: every tool call is offered to the tracker, which picks out
      // the progress-tracking ones itself. That keeps us independent of both
      // matcher-pattern semantics and which task/todo tool family the SDK
      // hands the agent (§6 checklist sync).
      PostToolUse: [
        {
          hooks: [
            async (hookInput) => {
              const hook = hookInput as {
                tool_name?: unknown;
                tool_input?: unknown;
                tool_response?: unknown;
              };
              const toolName = String(hook.tool_name ?? "");
              const items = checklist.record(toolName, hook.tool_input, hook.tool_response);
              if (items) {
                sync.setChecklist(items);
                const done = items.filter((i) => i.state === "completed").length;
                sync.log("debug", `checklist: ${done}/${items.length} complete`, run.stageRunRef);
              } else if (TRACKED_TOOLS.has(toolName)) {
                // A progress tool the tracker could make nothing of — an id it
                // never saw, a no-op update, or a response shape that drifted.
                // Say so: a silent hook is what hid this bug in the first place.
                sync.log("debug", `checklist: no update from ${toolName}`, run.stageRunRef);
              }
              return {};
            },
          ],
        },
      ],
    },
    maxTurns: 250,
  };

  const q = query({ prompt: input, options });

  let sessionId: string | undefined = run.sessionId;
  let interrupted: "pause" | "stop" | null = null;
  let finished = false;

  // control + steering watcher
  const watcher = setInterval(() => {
    if (finished || interrupted) return;
    if (sync.control === "pause" || sync.control === "stop") {
      interrupted = sync.control === "stop" ? "stop" : "pause";
      void q.interrupt().catch(() => {});
      input.end();
      return;
    }
    for (const text of sync.takeSteering()) {
      sync.log("info", `steering delivered: ${text.slice(0, 120)}`, run.stageRunRef);
      input.push(`[User steering message — adjust course accordingly]\n\n${text}`);
    }
  }, 1500);

  try {
    for await (const message of q as AsyncIterable<SDKMessage>) {
      appendTranscript(run.transcriptFile, message);

      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id;
        state.setSession(opts.stage, sessionId);
        // idempotent start re-send so the host records the session id (§6)
        void sync.stageStart({
          action: "start",
          stage: opts.stage,
          attempt: opts.attempt,
          model: opts.model,
          sessionId,
        });
        continue;
      }

      if (message.type === "assistant") {
        forwardAssistantLogs(sync, message, run.stageRunRef);
        const usage = message.message.usage;
        if (usage) {
          current.inputTokens += usage.input_tokens ?? 0;
          current.outputTokens += usage.output_tokens ?? 0;
          current.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
          current.cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
          pushUsage();
        }
        continue;
      }

      if (message.type === "result") {
        // result usage is authoritative for the whole query
        current.inputTokens = message.usage.input_tokens ?? current.inputTokens;
        current.outputTokens = message.usage.output_tokens ?? current.outputTokens;
        current.cacheReadTokens = message.usage.cache_read_input_tokens ?? current.cacheReadTokens;
        current.cacheCreationTokens =
          message.usage.cache_creation_input_tokens ?? current.cacheCreationTokens;
        pushUsage();
        persistUsageBase(state, run.stageRunRef, {
          inputTokens: usageBase.inputTokens + current.inputTokens,
          outputTokens: usageBase.outputTokens + current.outputTokens,
          cacheReadTokens: usageBase.cacheReadTokens + current.cacheReadTokens,
          cacheCreationTokens: usageBase.cacheCreationTokens + current.cacheCreationTokens,
        });

        // interrupt() aborts the in-flight turn, which the SDK reports as an
        // error_during_execution result (e.g. a tool_use left without its
        // result) — that's the pause/stop landing, not a failure. Drain and
        // let the interrupted branch below return paused/stopped.
        if (interrupted) continue;

        if (message.subtype !== "success") {
          const errText = message.errors.join("\n") || message.subtype;
          const limit = detectRateLimit(errText);
          if (limit) return { kind: "rate-limited", resetsAt: limit, sessionId };
          throw new AgentError(`agent run failed (${message.subtype}): ${errText.slice(0, 1000)}`);
        }

        // steering that arrived while the turn was finishing gets its own turn
        if (sync.hasPendingSteering()) continue;

        const followUp = opts.onTurnComplete ? await opts.onTurnComplete() : null;
        if (followUp) {
          sync.log("info", `gate feedback → agent: ${followUp.slice(0, 160)}`, run.stageRunRef);
          input.push(followUp);
        } else {
          finished = true;
          input.end();
        }
      }
    }
  } catch (err) {
    if (err instanceof StopRequested || err instanceof AgentError) throw err;
    const text = err instanceof Error ? err.message : String(err);
    const limit = detectRateLimit(text);
    if (limit) return { kind: "rate-limited", resetsAt: limit, sessionId };
    if (interrupted) {
      return { kind: interrupted === "stop" ? "stopped" : "paused", sessionId };
    }
    throw new AgentError(`agent query crashed: ${text.slice(0, 1000)}`);
  } finally {
    clearInterval(watcher);
    input.end();
  }

  if (interrupted) return { kind: interrupted === "stop" ? "stopped" : "paused", sessionId };
  if (!finished) {
    // query ended without a final result — treat as pause and let resume handle it
    await sleep(1000);
    return { kind: "paused", sessionId };
  }
  return { kind: "finished", sessionId };
}

function forwardAssistantLogs(sync: Syncer, message: SDKAssistantMessage, ref: string): void {
  for (const block of message.message.content) {
    if (block.type === "text" && block.text.trim()) {
      sync.log("info", block.text.trim().slice(0, 400), ref, "assistant");
    } else if (block.type === "thinking" && block.thinking.trim()) {
      sync.log("info", block.thinking.trim().slice(0, 400), ref, "thinking");
    } else if (block.type === "tool_use") {
      sync.log("debug", `→ ${block.name}`, ref);
    }
  }
}

function appendTranscript(file: string, message: SDKMessage): void {
  try {
    appendFileSync(file, `${JSON.stringify(message)}\n`);
  } catch {
    /* transcript loss is non-fatal */
  }
}

/**
 * Claude Max window exhaustion (§5): the SDK surfaces it as an error string.
 * Parse a reset time when present; otherwise assume a 30-minute backoff.
 */
export function detectRateLimit(text: string): string | null {
  if (!/usage limit|rate limit|limit reached|limit_error|overloaded/i.test(text)) return null;
  const epoch = /(?:resets?(?:_at|At)?["':\s|]+)(\d{10,13})/.exec(text)?.[1];
  if (epoch) {
    const ms = epoch.length === 13 ? Number(epoch) : Number(epoch) * 1000;
    return new Date(ms).toISOString();
  }
  return new Date(Date.now() + 30 * 60 * 1000).toISOString();
}

// usage persistence across container restarts -------------------------------

function readUsageBase(state: StateStore, ref: string): UsageTotals | undefined {
  return state.get().usageByRun[ref];
}

function persistUsageBase(state: StateStore, ref: string, totals: UsageTotals): void {
  state.update({ usageByRun: { ...state.get().usageByRun, [ref]: totals } });
}
