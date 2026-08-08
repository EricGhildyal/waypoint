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
  private answerQueue: Array<{ id: string; questionId: string; answer: string }> = [];

  control: SyncResponse["control"] = "run";
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

  stageStart(stage: SyncStage & { action: "start" }): Promise<void> {
    this.stageMsgs.push(stage);
    return this.syncNow();
  }

  stageEnd(stage: SyncStage & { action: "end" }): Promise<void> {
    this.stageMsgs.push(stage);
    return this.syncNow();
  }

  reportRateLimit(resetsAt: string): Promise<void> {
    this.rateLimit = { resetsAt };
    return this.syncNow();
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
  async ask(question: SyncQuestion): Promise<string> {
    this.question = question;
    await this.syncNow();
    for (;;) {
      const answer = this.takeAnswer();
      if (answer) return answer.answer;
      if (this.control === "stop") throw new StopRequested();
      await sleep(1500);
    }
  }

  /** Non-blocking: consume the next unseen answer, if any. */
  takeAnswer(): { id: string; questionId: string; answer: string } | null {
    const item = this.answerQueue.shift();
    if (!item) return null;
    const consumed = this.state.get().consumedAnswers;
    this.state.update({ consumedAnswers: [...consumed.slice(-50), item.id] });
    return item;
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
        if (body.checklist && !this.checklist) this.checklist = body.checklist;
        // latest-wins: a warning queued while this sync was inflight is newer
        if (body.rateLimitWarning && !this.rateLimitWarning) {
          this.rateLimitWarning = body.rateLimitWarning;
        }
        this.requeueUsageWindows(body.usageWindows);
        return;
      }
      const data = (await res.json()) as SyncResponse;
      this.control = data.control;
      this.ingestInbox(data.inbox);
    } catch {
      // network hiccup — re-queue and retry next tick
      if (body.events) this.events.unshift(...body.events);
      if (body.stage) this.stageMsgs.unshift(body.stage);
      if (body.question) this.question = body.question;
      if (body.rateLimit) this.rateLimit = body.rateLimit;
      if (body.checklist && !this.checklist) this.checklist = body.checklist;
      if (body.rateLimitWarning && !this.rateLimitWarning) {
        this.rateLimitWarning = body.rateLimitWarning;
      }
      this.requeueUsageWindows(body.usageWindows);
    } finally {
      this.inflight = false;
      // there are queued stage messages or an explicit request — go again
      if (this.stageMsgs.length || this.syncNowRequested) setImmediate(() => void this.sync());
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
        this.answerQueue.push({ id: item.id, questionId: item.questionId, answer: item.answer });
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

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
