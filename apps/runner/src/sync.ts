import { createHash } from "node:crypto";
import type { RunnerConfig } from "./config";
import type { StateStore } from "./state";
import type {
  ChecklistItem,
  InboxItem,
  SyncEvent,
  SyncQuestion,
  SyncRequest,
  SyncResponse,
  SyncStage,
  SyncUsage,
  UsageWindow,
} from "./types";

export class StopRequested extends Error {
  constructor() {
    super("host requested stop");
  }
}

/**
 * The single sync channel (§6): POST /api/runner/tasks/{id}/sync every 3s
 * while running, and immediately after anything noteworthy. Doubles as the
 * heartbeat. Batches events, carries usage/checklist/questions/stage
 * lifecycle, and receives steering + answers + the control signal back.
 */
export class Syncer {
  private events: SyncEvent[] = [];
  private usage: SyncUsage | null = null;
  private checklist: ChecklistItem[] | null = null;
  private question: SyncQuestion | null = null;
  private stageMsgs: SyncStage[] = [];
  private rateLimit: { resetsAt: string } | null = null;
  private rateLimitWarning: { utilization?: number; resetsAt?: string } | null = null;
  private usageWindows = new Map<string, UsageWindow>();

  private steeringQueue: Array<{ id: string; text: string }> = [];
  private answerQueue: Array<{ id: string; key?: string; answer: string }> = [];
  /** ask() calls run one at a time — there is a single outbound question slot. */
  private asking: Promise<unknown> = Promise.resolve();

  control: SyncResponse["control"] = "run";
  /** Latest value from the host; see SyncResponse.prFeedback. */
  prFeedback: string | undefined;
  private timer: NodeJS.Timeout | null = null;
  private inflight = false;
  private syncNowRequested = false;

  constructor(
    private readonly config: RunnerConfig,
    private readonly state: StateStore,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.sync(), 3000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // --- outbound queueing ---------------------------------------------------

  log(
    level: "debug" | "info" | "warn" | "error",
    line: string,
    stageRunId?: string,
    source?: "assistant" | "thinking",
  ): void {
    if (this.events.length >= 90) return; // sync cap safety; transcript keeps everything
    this.events.push({
      type: "LOG",
      payload: { level, line: line.slice(0, 500), ...(source ? { source } : {}) },
      stageRunId,
    });
  }

  error(code: string, message: string, logTail?: string): void {
    this.events.push({
      type: "ERROR",
      payload: {
        code,
        message: message.slice(0, 2000),
        ...(logTail ? { logTail: logTail.slice(0, 4000) } : {}),
      },
    });
  }

  setUsage(usage: SyncUsage): void {
    this.usage = usage;
  }

  setChecklist(items: ChecklistItem[]): void {
    this.checklist = items;
  }

  /**
   * Stage lifecycle messages resolve only once the host has them. Callers
   * persist the next phase right after, and a restart reads that phase back —
   * a message still sitting in memory at that point would be lost for good
   * (a lost TESTING end means the pull request is never opened).
   */
  stageStart(stage: SyncStage & { action: "start" }): Promise<void> {
    this.stageMsgs.push(stage);
    return this.deliver(() => this.stageMsgs.includes(stage));
  }

  stageEnd(stage: SyncStage & { action: "end" }): Promise<void> {
    this.stageMsgs.push(stage);
    return this.deliver(() => this.stageMsgs.includes(stage));
  }

  /** Resolves once the host knows — the caller then waits for it to say "pause". */
  reportRateLimit(resetsAt: string): Promise<void> {
    const report = { resetsAt };
    this.rateLimit = report;
    return this.deliver(() => this.rateLimit === report);
  }

  /** Sync until `pending()` is false, i.e. until what it watches was accepted. */
  private async deliver(pending: () => boolean): Promise<void> {
    for (;;) {
      // a request in flight has taken the item out of its queue; wait for the
      // outcome (a failure puts it back) before judging
      while (this.inflight) await sleep(100);
      if (!pending()) return;
      if (this.control === "stop") throw new StopRequested();
      const sentAt = Date.now();
      await this.sync();
      // still pending after a quick failure: don't hammer a host that is down
      if (pending() && Date.now() - sentAt < 1000) await sleep(1000);
    }
  }

  /**
   * Approaching the window (SDK `allowed_warning`) — latest wins, rides the
   * next 3s sync. Display only: nothing pauses on a warning.
   */
  reportRateLimitWarning(warning: { utilization?: number; resetsAt?: string }): void {
    this.rateLimitWarning = warning;
  }

  /**
   * One Claude limit window's utilization — latest wins per window type, rides
   * the next 3s sync. Display only: the settings page bars, nothing else.
   */
  reportUsageWindow(window: UsageWindow): void {
    this.usageWindows.set(window.type, window);
  }

  // --- questions & answers -------------------------------------------------

  /** Send a question and block until its answer arrives via the inbox. */
  ask(question: SyncQuestion): Promise<string> {
    // two agents' ask_user calls must not overwrite each other's question
    const next = this.asking.then(
      () => this.askOne(question),
      () => this.askOne(question),
    );
    this.asking = next.catch(() => {});
    return next;
  }

  private async askOne(question: SyncQuestion): Promise<string> {
    const key = questionKey(question.kind, question.text);
    this.question = question;
    await this.syncNow();
    for (;;) {
      const answer = this.takeAnswer(key);
      if (answer !== null) return answer;
      if (this.control === "stop") throw new StopRequested();
      await sleep(1500);
    }
  }

  /**
   * Consume the answer to the question identified by `key`. Answers to any
   * other question are dropped: they belong to a question asked before a
   * restart (the stage that asked started over), and handing one to whoever
   * asks next would, say, turn a reply to an agent's question into the user's
   * pick of review findings.
   */
  private takeAnswer(key: string): string | null {
    let found: string | null = null;
    while (found === null) {
      const item = this.answerQueue.shift();
      if (!item) break;
      const consumed = this.state.get().consumedAnswers;
      this.state.update({ consumedAnswers: [...consumed.slice(-50), item.id] });
      // no key = a host that predates keys; keep its first-come behaviour
      if (item.key === undefined || item.key === key) found = item.answer;
      else this.log("warn", "dropped an answer to a question nobody is waiting on any more");
    }
    return found;
  }

  /** Drain queued steering texts (delivered mid-run into the agent's input). */
  takeSteering(): string[] {
    const items = this.steeringQueue.splice(0);
    return items.map((i) => i.text);
  }

  hasPendingSteering(): boolean {
    return this.steeringQueue.length > 0;
  }

  // --- the wire ------------------------------------------------------------

  async syncNow(): Promise<void> {
    this.syncNowRequested = true;
    await this.sync();
  }

  /**
   * Drain every outbound queue before process exit — a plain syncNow() can
   * no-op on the inflight guard and lose the final ERROR/stage message.
   */
  async flush(): Promise<void> {
    for (let round = 0; round < 10; round++) {
      while (this.inflight) await sleep(100);
      if (
        this.events.length === 0 &&
        this.stageMsgs.length === 0 &&
        !this.question &&
        !this.usage &&
        !this.rateLimit &&
        !this.rateLimitWarning &&
        this.usageWindows.size === 0 &&
        !this.checklist
      ) {
        return;
      }
      await this.sync();
    }
  }

  private async sync(): Promise<void> {
    if (this.inflight) return;
    this.inflight = true;
    this.syncNowRequested = false;

    let delivered = false;
    const body: SyncRequest = { cursor: this.state.get().inboxCursor };
    if (this.events.length) body.events = this.events.splice(0, 100);
    if (this.usage) {
      body.usage = this.usage;
      this.usage = null;
    }
    if (this.checklist) {
      body.checklist = this.checklist;
      this.checklist = null;
    }
    if (this.question) {
      body.question = this.question;
      this.question = null;
    }
    const stageMsg = this.stageMsgs.shift();
    if (stageMsg) body.stage = stageMsg;
    if (this.rateLimit) {
      body.rateLimit = this.rateLimit;
      this.rateLimit = null;
    }
    if (this.rateLimitWarning) {
      body.rateLimitWarning = this.rateLimitWarning;
      this.rateLimitWarning = null;
    }
    if (this.usageWindows.size) {
      body.usageWindows = [...this.usageWindows.values()];
      this.usageWindows.clear();
    }

    try {
      const res = await fetch(
        `${this.config.hostApi}/api/runner/tasks/${this.config.taskId}/sync`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.config.runnerToken}`,
          },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        // re-queue what we tried to send (401 after cancel resolves via control)
        if (body.events) this.events.unshift(...body.events);
        if (body.stage) this.stageMsgs.unshift(body.stage);
        if (body.question) this.question = body.question;
        if (body.rateLimit) this.rateLimit = body.rateLimit;
        // never clobber a snapshot that landed while this request was in flight
        if (body.usage && !this.usage) this.usage = body.usage;
        if (body.checklist && !this.checklist) this.checklist = body.checklist;
        // latest-wins: a warning queued while this sync was inflight is newer
        if (body.rateLimitWarning && !this.rateLimitWarning) {
          this.rateLimitWarning = body.rateLimitWarning;
        }
        this.requeueUsageWindows(body.usageWindows);
        return;
      }
      const data = (await res.json()) as SyncResponse;
      delivered = true;
      this.control = data.control;
      this.prFeedback = data.prFeedback;
      this.ingestInbox(data.inbox);
    } catch {
      // network hiccup — re-queue and retry next tick
      if (body.events) this.events.unshift(...body.events);
      if (body.stage) this.stageMsgs.unshift(body.stage);
      if (body.question) this.question = body.question;
      if (body.rateLimit) this.rateLimit = body.rateLimit;
      if (body.usage && !this.usage) this.usage = body.usage;
      if (body.checklist && !this.checklist) this.checklist = body.checklist;
      if (body.rateLimitWarning && !this.rateLimitWarning) {
        this.rateLimitWarning = body.rateLimitWarning;
      }
      this.requeueUsageWindows(body.usageWindows);
    } finally {
      this.inflight = false;
      // there are queued stage messages or an explicit request — go again. Only
      // after a success: a failed sync just re-queued its stage message, and
      // retrying at once would spin as fast as the request can fail. The 3s
      // timer (and deliver()'s own backoff) covers the failure case.
      if (delivered && (this.stageMsgs.length || this.syncNowRequested)) {
        setImmediate(() => void this.sync());
      }
    }
  }

  /** Put back windows a failed sync was carrying, per type — a reading queued
   * while the request was inflight is newer, so it wins. */
  private requeueUsageWindows(windows: UsageWindow[] | undefined): void {
    for (const window of windows ?? []) {
      if (!this.usageWindows.has(window.type)) this.usageWindows.set(window.type, window);
    }
  }

  private ingestInbox(items: InboxItem[]): void {
    const consumed = new Set(this.state.get().consumedAnswers);
    for (const item of items) {
      if (item.type === "steering") {
        if (!this.steeringQueue.some((s) => s.id === item.id)) {
          this.steeringQueue.push({ id: item.id, text: item.text });
        }
      } else if (!consumed.has(item.id) && !this.answerQueue.some((a) => a.id === item.id)) {
        this.answerQueue.push({ id: item.id, key: item.key, answer: item.answer });
      }
      this.state.update({ inboxCursor: item.id });
    }
  }

  /** Block until control returns to "run" (used for pause / rate-limit windows). */
  async waitForRun(): Promise<void> {
    for (;;) {
      if (this.control === "stop") throw new StopRequested();
      if (this.control === "run") return;
      await sleep(3000);
    }
  }
}

/** Identifies a question across the wire; the host computes the same value. */
export function questionKey(kind: string, text: string): string {
  return createHash("sha256").update(`${kind}\n${text}`).digest("hex");
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
