import { promises as fs } from "node:fs";
import path from "node:path";
import { AgentError, type Effort, runStageAgent } from "./agent";
import type { RunnerConfig } from "./config";
import { runFormatAndLint, runTestGate, testGateLabel } from "./coverage";
import { dockerEnabled } from "./dockerd";
import { spawnDetached, tail } from "./proc";
import { renderPrompt } from "./prompts";
import type { StateStore } from "./state";
import { StopRequested, type Syncer, sleep } from "./sync";
import {
  AUTO_FIX_CATEGORIES,
  CYCLE_CAP_OPTION_CANCEL,
  CYCLE_CAP_OPTION_CONTINUE,
  type ChecklistItem,
  type Finding,
  type FindingApprovalItem,
  type FindingCategory,
  type Findings,
  REVIEW_CYCLE_CAP,
  type StageName,
  TESTING_CYCLE_CAP,
  isPlanApproval,
  parseFindingSelection,
} from "./types";
import {
  abortLeftoverMerge,
  commitLeftovers,
  conflictedFiles,
  ensureBranch,
  mergeInProgress,
  pushBranch,
  readWorkspaceFile,
  refreshDefaultCheckout,
  resetTo,
  type SyncOutcome,
  headSha,
  syncWithDefaultBranch,
} from "./workspace";

const IMPL_GATE_CAP = 5;
const MERGE_GATE_CAP = 3;
const PR_FEEDBACK_GATE_CAP = 3;

type Role = StageName | "MERGE";

/**
 * Thinking effort per agent role, by task difficulty. Planning and review
 * default to Fable 5.2, whose recommended starting point is `high`; the other
 * roles default to Opus 5.5, whose recommended starting point is `medium`.
 * That is the MEDIUM row. An easy task steps down (the model's lower levels
 * handle well-specified work, at a fraction of the tokens); a hard one steps
 * the Opus roles up. Fable stays at `high` even there: gains above it are
 * uneven and cost many times the tokens. Merge-conflict resolution never drops
 * below `medium` — its difficulty comes from the conflict, not the task.
 */
const EFFORT: Record<string, Record<Role, Effort>> = {
  EASY: {
    PLANNING: "medium",
    IMPLEMENTATION: "low",
    REVIEW: "medium",
    TESTING: "low",
    MERGE: "medium",
    PR_FEEDBACK: "low",
  },
  MEDIUM: {
    PLANNING: "high",
    IMPLEMENTATION: "medium",
    REVIEW: "high",
    TESTING: "medium",
    MERGE: "medium",
    PR_FEEDBACK: "medium",
  },
  HARD: {
    PLANNING: "high",
    IMPLEMENTATION: "high",
    REVIEW: "high",
    TESTING: "medium",
    MERGE: "high",
    PR_FEEDBACK: "high",
  },
};

function effortFor(config: RunnerConfig, role: Role): Effort {
  return (EFFORT[config.meta.difficulty] ?? EFFORT.MEDIUM)?.[role] ?? "medium";
}

// ---------------------------------------------------------------------------
// Planning (§7) — fresh session; output contract: /workspace/.waypoint/plan.md
// ---------------------------------------------------------------------------

export async function runPlanning(
  config: RunnerConfig,
  sync: Syncer,
  state: StateStore,
): Promise<void> {
  const attempt = state.nextAttempt("PLANNING");
  const model = config.meta.models.planning;
  await sync.stageStart({ action: "start", stage: "PLANNING", attempt, model });
  // plan against the default branch as it is now, not as it was at clone time
  await refreshDefaultCheckout(config, sync);

  const notes = state.get().planNotes;
  const stagePrompt = renderPrompt("planning", config);
  const prompt = notes
    ? `The user reviewed your plan and requested changes. Revise /workspace/.waypoint/plan.md accordingly (same output contract as before), then stop.\n\nUser's revision notes:\n${notes}`
    : stagePrompt;
  const resumeSessionId = notes ? state.get().sessions.PLANNING : undefined;
  // Used only if that session is gone: the revision prompt above assumes the
  // prior conversation, so a fresh agent needs the whole stage prompt back.
  const freshPrompt = notes
    ? [
        stagePrompt,
        "",
        "---",
        "",
        "You already wrote a plan for this task in a previous session that is no longer available. /workspace/.waypoint/plan.md still holds it — read it first and revise it in place to address the user's notes below, rather than starting over.",
        "",
        "User's revision notes:",
        notes,
      ].join("\n")
    : undefined;

  let nudges = 0;
  const result = await runStageAgent(config, sync, state, {
    stage: "PLANNING",
    attempt,
    model,
    effort: effortFor(config, "PLANNING"),
    initialPrompt: prompt,
    resumeSessionId,
    freshPrompt,
    onTurnComplete: async () => {
      const plan = await readWorkspaceFile(config, ".waypoint/plan.md");
      if (!plan && nudges < 2) {
        nudges++;
        return "`/workspace/.waypoint/plan.md` does not exist yet. Write the complete plan there in the format from your instructions; it is the only output of this stage.";
      }
      return null;
    },
  });

  const plan = (await readWorkspaceFile(config, ".waypoint/plan.md")) ?? "";
  if (!plan) {
    await sync.stageEnd({
      action: "end",
      stage: "PLANNING",
      attempt,
      status: "FAILED",
      sessionId: result.sessionId,
    });
    throw new Error("planning produced no plan.md");
  }

  // first checklist snapshot from the plan's checkboxes (§7)
  const checklist = parseCheckboxes(plan);
  if (checklist.length) sync.setChecklist(checklist);

  await sync.stageEnd({
    action: "end",
    stage: "PLANNING",
    attempt,
    status: "SUCCEEDED",
    sessionId: result.sessionId,
    artifacts: [{ name: "plan.md", content: plan }],
  });

  state.update({ planNotes: null, phase: "AWAIT_PLAN" });
}

/** Every task pauses here (§1 plan gate) until the PLAN_APPROVAL answer arrives. */
export async function awaitPlanApproval(
  config: RunnerConfig,
  sync: Syncer,
  state: StateStore,
): Promise<void> {
  if (config.meta.autoApprovePlan) {
    // Easy tasks skip the gate (Settings → "Auto-approve easy plans"). The
    // plan is still on the task page, and the pull request is still reviewed.
    sync.log("info", "easy task — plan approved automatically, starting implementation");
    state.update({ phase: "IMPLEMENTING", planNotes: null });
    return;
  }
  const plan = (await readWorkspaceFile(config, ".waypoint/plan.md")) ?? "(plan missing)";
  const answer = await sync.ask({
    kind: "PLAN_APPROVAL",
    text: plan,
    contextSummary: `The plan for "${config.meta.title}" is ready. Reply "approve" to start implementation, or reply with revision notes.`,
  });

  if (isPlanApproval(answer)) {
    sync.log("info", "plan approved — starting implementation");
    state.update({ phase: "IMPLEMENTING", planNotes: null });
  } else {
    sync.log("info", "plan revision requested — resuming planning");
    state.update({ phase: "PLANNING", planNotes: answer });
  }
}

// ---------------------------------------------------------------------------
// Implementation (§7) — first attempt seeded with plan.md; fix-ups resume the
// same session; the runner drives the green-tests + changed-line-coverage gate.
// ---------------------------------------------------------------------------

export async function runImplementation(
  config: RunnerConfig,
  sync: Syncer,
  state: StateStore,
): Promise<void> {
  const attempt = state.nextAttempt("IMPLEMENTATION");
  const model = config.meta.models.implementation;
  await sync.stageStart({ action: "start", stage: "IMPLEMENTATION", attempt, model });
  await ensureBranch(config, sync);
  await syncAtBoundary(config, sync, state, "IMPLEMENTATION", attempt);

  const pending = state.get().pendingFindings;
  const priorSession = state.get().sessions.IMPLEMENTATION;
  const plan = (await readWorkspaceFile(config, ".waypoint/plan.md")) ?? "";
  const stagePrompt = renderPrompt("implementation", config, { PLAN: plan });
  const fixup = pending && priorSession ? pending : undefined;
  // A session with no findings pending means this round was interrupted (a
  // long rate limit or pause, an unanswered question, a lost heartbeat — the
  // container was stopped and started again). Pick that session back up
  // instead of handing a new agent the plan as if nothing had been built.
  const interrupted = !pending && priorSession ? priorSession : undefined;
  const prompt = fixup ? fixupPrompt(fixup) : interrupted ? CONTINUE_PROMPT : stagePrompt;
  // Used only if that session is gone: the fix-up prompt assumes the prior
  // conversation, so a fresh agent needs the plan and stage rules back — plus
  // a note that the plan is already done, or it would implement it twice.
  const freshPrompt = fixup
    ? [
        stagePrompt,
        "",
        "---",
        "",
        "The plan above is already implemented and committed on this branch — do not redo it; it is here for context only. The previous session is no longer available, so re-read the relevant code before you change anything. Your job in this round is exactly the following:",
        "",
        fixupPrompt(fixup),
      ].join("\n")
    : interrupted
      ? [
          stagePrompt,
          "",
          "---",
          "",
          `An earlier session already started on this plan and was interrupted; it is no longer available. Its commits are on this branch (\`git log origin/${config.meta.project.defaultBranch}..HEAD\`) and its uncommitted work was committed as a checkpoint. Read what is there first, then continue from where it stopped instead of starting over.`,
        ].join("\n")
      : undefined;

  let gateRounds = 0;
  let askedPrMd = false;

  const result = await runStageAgent(config, sync, state, {
    stage: "IMPLEMENTATION",
    attempt,
    model,
    effort: effortFor(config, "IMPLEMENTATION"),
    initialPrompt: prompt,
    resumeSessionId: fixup ? priorSession : interrupted,
    freshPrompt,
    onTurnComplete: async () => {
      // Loop: tests green AND changed-line coverage ≥ bar → then format+lint →
      // then pr.md — each failure resumes the same session with feedback (§7).
      gateRounds++;
      if (gateRounds > IMPL_GATE_CAP) {
        const answer = await sync.ask({
          kind: "QUESTION",
          text: `Implementation has been through ${IMPL_GATE_CAP} verification rounds without clearing the test gate. Keep going, or cancel?`,
          contextSummary: `"${config.meta.title}" can't clear its test/coverage gate after ${IMPL_GATE_CAP} rounds.`,
          options: [CYCLE_CAP_OPTION_CONTINUE, CYCLE_CAP_OPTION_CANCEL],
        });
        if (/^cancel/i.test(answer)) {
          await waitForStop(sync);
        }
        gateRounds = 0;
      }

      sync.log("info", testGateLabel(config));
      const gate = await runTestGate(config);
      if (!gate.ok) return gate.feedback;

      const style = await runFormatAndLint(config);
      if (!style.ok) return style.feedback;

      const prMd = await readWorkspaceFile(config, ".waypoint/pr.md");
      if (!prMd && !askedPrMd) {
        askedPrMd = true;
        return 'All checks pass. Write `/workspace/.waypoint/pr.md` as described under "Final step", then commit anything still uncommitted.';
      }
      return null;
    },
  });

  await commitLeftovers(config, "chore: finalize implementation round");
  const prMd = await readWorkspaceFile(config, ".waypoint/pr.md");
  await sync.stageEnd({
    action: "end",
    stage: "IMPLEMENTATION",
    attempt,
    status: "SUCCEEDED",
    sessionId: result.sessionId,
    ...(prMd ? { artifacts: [{ name: "pr.md", content: prMd }] } : {}),
  });

  state.update({ pendingFindings: null, phase: "REVIEW" });
}

const CONTINUE_PROMPT =
  "You were interrupted and the container was restarted. Continue where you left off: check `git status` and your task list, then pick the work back up from the last completed step.";

function fixupPrompt(pending: { source: "review" | "testing"; findings: Findings }): string {
  const items = pending.findings.findings
    .map(
      (f, i) =>
        `${i + 1}. [${f.severity ?? "finding"} · ${f.category}] ${f.file}: ${f.description}${f.suggestion ? `\n   Suggestion: ${f.suggestion}` : ""}`,
    )
    .join("\n");
  return [
    pending.source === "review"
      ? "The code review requested changes and the user approved the findings below. Address each one, keeping the plan's intent. Limit the diff to these findings and what they force; findings the user declined have already been dropped from this list. Commit as you go."
      : "The testing stage found problems while exercising the app in a real browser. Fix them, keeping the plan's intent. Commit as you go.",
    "",
    items,
    "",
    "When done, make sure tests still pass and update /workspace/.waypoint/pr.md if the summary changed.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Review (§7) — FRESH session, no implementation context pollution.
// ---------------------------------------------------------------------------

export async function runReview(
  config: RunnerConfig,
  sync: Syncer,
  state: StateStore,
): Promise<void> {
  const attempt = state.nextAttempt("REVIEW");
  const model = config.meta.models.review;
  await sync.stageStart({ action: "start", stage: "REVIEW", attempt, model });

  const plan = (await readWorkspaceFile(config, ".waypoint/plan.md")) ?? "";
  let nudges = 0;
  const result = await runStageAgent(config, sync, state, {
    stage: "REVIEW",
    attempt,
    model,
    effort: effortFor(config, "REVIEW"),
    initialPrompt: renderPrompt("review", config, { PLAN: plan }),
    onTurnComplete: async () => {
      const problem = await findingsProblem(config, ".waypoint/review-findings.json");
      if (problem && nudges < 2) {
        nudges++;
        return `\`/workspace/.waypoint/review-findings.json\` ${problem}. Write it now using the JSON contract from your instructions. If you found nothing, write an \`approve\` verdict with an empty \`findings\` array.`;
      }
      return null;
    },
  });

  const findings = await readFindings(config, sync, ".waypoint/review-findings.json");
  await sync.stageEnd({
    action: "end",
    stage: "REVIEW",
    attempt,
    status: "SUCCEEDED",
    sessionId: result.sessionId,
    artifacts: [
      { name: `review-findings-${attempt}.json`, content: JSON.stringify(findings, null, 2) },
    ],
  });
  await fs.rm(path.join(config.workspace, ".waypoint/review-findings.json"), { force: true });

  if (findings.verdict !== "request_changes") {
    sync.log("info", "review approved");
    state.update({ phase: "TESTING" });
    return;
  }

  const cycles = state.get().reviewCycles + 1;
  state.update({ reviewCycles: cycles });
  if (cycles > REVIEW_CYCLE_CAP) {
    await cycleCapQuestion(config, sync, state, "review", cycles, findings);
    return;
  }

  routeReviewFindings(sync, state, findings, `cycle ${cycles}/${REVIEW_CYCLE_CAP}`);
}

/**
 * The review gate (§7): readability + simplification findings cycle back on the
 * agent's own authority; everything else waits for a yes/no per finding. The
 * gate gets its own phase so a container stopped while the approval email sits
 * unanswered resumes into the gate instead of re-running the whole review.
 */
function routeReviewFindings(
  sync: Syncer,
  state: StateStore,
  findings: Findings,
  note: string,
): void {
  const auto = findings.findings.filter((f) => AUTO_FIX_CATEGORIES.includes(f.category));
  const gated = findings.findings.filter((f) => !AUTO_FIX_CATEGORIES.includes(f.category));

  if (gated.length === 0) {
    sync.log(
      "info",
      `review requested ${auto.length} readability/simplification change(s) — fixing without approval (${note})`,
    );
    startFixRound(state, auto);
    return;
  }
  sync.log("info", `${gated.length} finding(s) need approval before any fix round (${note})`);
  state.update({ pendingApproval: { auto, gated }, phase: "AWAIT_FINDINGS" });
}

/**
 * The review gate (§7). Sends the gated findings out as a numbered checkbox
 * list (email + UI) and blocks until the user picks. What they tick is fixed,
 * along with the auto-fix findings; what they leave unticked is dropped.
 */
export async function awaitFindingsApproval(
  config: RunnerConfig,
  sync: Syncer,
  state: StateStore,
): Promise<void> {
  const pending = state.get().pendingApproval;
  if (!pending) {
    // nothing waiting (stale state after a restart) — don't stall the pipeline
    state.update({ phase: "TESTING" });
    return;
  }
  const { auto, gated } = pending;

  const items: FindingApprovalItem[] = [
    ...gated.map((f, i) => ({ ...f, number: i + 1, auto: false })),
    ...auto.map((f) => ({ ...f, number: null, auto: true })),
  ];

  const lines = [
    `The code review found ${gated.length} issue${gated.length === 1 ? "" : "s"} that need your call. Tick the ones you want fixed.`,
    "",
    ...gated.map(
      (f, i) =>
        `${i + 1}. [${f.severity ?? "finding"} · ${f.category}] ${f.file}\n   ${f.description}${f.suggestion ? `\n   Suggestion: ${f.suggestion}` : ""}`,
    ),
  ];
  if (auto.length) {
    lines.push(
      "",
      `Fixed automatically either way (${auto.length} readability/simplification finding${auto.length === 1 ? "" : "s"}):`,
      ...auto.map((f) => `• ${f.file} — ${f.description}`),
    );
  }
  lines.push("", 'Reply with the numbers you want fixed (e.g. "1, 3"), or "none".');

  const answer = await sync.ask({
    kind: "FINDINGS_APPROVAL",
    text: lines.join("\n"),
    contextSummary: `The review of "${config.meta.title}" raised ${gated.length} finding${gated.length === 1 ? "" : "s"} needing your approval${auto.length ? `, plus ${auto.length} readability/simplification fix${auto.length === 1 ? "" : "es"} that will be applied automatically` : ""}.`,
    items,
  });

  const picked = parseFindingSelection(answer, gated.length);
  sync.log("info", `approved ${picked.length}/${gated.length} gated finding(s)`);
  const toFix = [
    ...picked.map((n) => gated[n - 1]).filter((f): f is Finding => Boolean(f)),
    ...auto,
  ];
  state.update({ pendingApproval: null });
  startFixRound(state, toFix);
}

/** Route to a fix round, or straight on to testing when there is nothing to fix. */
function startFixRound(state: StateStore, toFix: Finding[]): void {
  if (toFix.length === 0) {
    state.update({ phase: "TESTING" });
    return;
  }
  state.update({
    pendingFindings: {
      source: "review",
      findings: { verdict: "request_changes", findings: toFix },
    },
    phase: "IMPLEMENTING",
  });
}

// ---------------------------------------------------------------------------
// Testing (§7) — hybrid: real Chromium via Playwright MCP, validated flows
// persisted as committed Playwright specs. Runner starts the app first.
// ---------------------------------------------------------------------------

export async function runTesting(
  config: RunnerConfig,
  sync: Syncer,
  state: StateStore,
): Promise<void> {
  const attempt = state.nextAttempt("TESTING");
  const model = config.meta.models.testing;
  const { project } = config.meta;
  await sync.stageStart({ action: "start", stage: "TESTING", attempt, model });

  // Per-task skip (§7): no app boot, no browser agent — run the test suite one
  // final time (when configured), push, and hand off to PR creation.
  if (config.meta.skipTesting) {
    sync.log("info", "browser testing skipped for this task — running test suite, then pushing");
    sync.log("info", testGateLabel(config));
    const gate = await runTestGate(config);
    if (!gate.ok) {
      // a red suite is a TEST finding, not an infra failure — bounce (§7)
      const findings: Findings = {
        verdict: "request_changes",
        findings: [
          { severity: "high", category: "bug", file: "(tests)", description: gate.feedback },
        ],
      };
      await sync.stageEnd({
        action: "end",
        stage: "TESTING",
        attempt,
        status: "SUCCEEDED",
        artifacts: [
          { name: `test-findings-${attempt}.json`, content: JSON.stringify(findings, null, 2) },
        ],
      });
      await bounceFromTesting(config, sync, state, findings, attempt);
      return;
    }

    const findings: Findings = { verdict: "approve", findings: [] };
    // the merge below needs a clean tree, and whatever the gate or the review
    // left behind belongs on the branch rather than in a merge commit
    await commitLeftovers(config, "chore: finalize before push");
    await syncAndPush(config, sync, state, "TESTING", attempt);
    const prMd =
      (await readWorkspaceFile(config, ".waypoint/pr.md")) ?? "Automated change by Waypoint.";
    await sync.stageEnd({
      action: "end",
      stage: "TESTING",
      attempt,
      status: "SUCCEEDED",
      artifacts: [
        { name: "pr.md", content: prMd },
        { name: `test-findings-${attempt}.json`, content: JSON.stringify(findings, null, 2) },
      ],
    });
    state.update({ phase: "AWAIT_STOP" });
    return;
  }

  // Test against the default branch as it is now: a change that landed since
  // the branch was cut is exactly what a browser pass should run on top of.
  await syncAtBoundary(config, sync, state, "TESTING", attempt);

  sync.log("info", `starting app: ${project.runCommand}`);
  const app = spawnDetached(project.runCommand, {
    cwd: config.workspace,
    onLine: (line) => sync.log("debug", `[app] ${line}`),
  });

  try {
    const ready = await waitForReady(project.runReadyUrl, READY_TIMEOUT_MS());
    if (!ready) {
      // readiness timeout is a TEST finding, not an infra failure (§7)
      const findings: Findings = {
        verdict: "request_changes",
        findings: [
          {
            severity: "high",
            category: "bug",
            file: "(run)",
            description: `The app failed to become ready at ${project.runReadyUrl} within ${READY_TIMEOUT_MS() / 1000}s when started with \`${project.runCommand}\`. Log tail:\n${tail(app.output(), 3000)}`,
          },
        ],
      };
      await sync.stageEnd({
        action: "end",
        stage: "TESTING",
        attempt,
        status: "SUCCEEDED",
        artifacts: [
          { name: `test-findings-${attempt}.json`, content: JSON.stringify(findings, null, 2) },
        ],
      });
      await bounceFromTesting(config, sync, state, findings, attempt);
      return;
    }

    let nudges = 0;
    const result = await runStageAgent(config, sync, state, {
      stage: "TESTING",
      attempt,
      model,
      effort: effortFor(config, "TESTING"),
      playwright: true,
      initialPrompt: renderPrompt("testing", config, {
        PLAN: (await readWorkspaceFile(config, ".waypoint/plan.md")) ?? "",
        APP_URL: project.runReadyUrl ?? "http://localhost:3000",
      }),
      onTurnComplete: async () => {
        const problem = await findingsProblem(config, ".waypoint/test-findings.json");
        if (problem && nudges < 2) {
          nudges++;
          return `\`/workspace/.waypoint/test-findings.json\` ${problem}. Write it now using the JSON contract from your instructions. If you found nothing, write an \`approve\` verdict with an empty \`findings\` array. Commit the Playwright specs for the flows you validated.`;
        }
        return null;
      },
    });

    const findings = await readFindings(config, sync, ".waypoint/test-findings.json");
    await commitLeftovers(config, "test: persist validated Playwright specs");
    await fs.rm(path.join(config.workspace, ".waypoint/test-findings.json"), { force: true });

    if (findings.verdict === "request_changes") {
      await sync.stageEnd({
        action: "end",
        stage: "TESTING",
        attempt,
        status: "SUCCEEDED",
        sessionId: result.sessionId,
        artifacts: [
          { name: `test-findings-${attempt}.json`, content: JSON.stringify(findings, null, 2) },
        ],
      });
      await bounceFromTesting(config, sync, state, findings, attempt);
      return;
    }

    // testing success: the RUNNER pushes (it has the repo + PAT, §7); the
    // orchestrator opens the PR once the stage end lands (→ OPENING_PR).
    // The browser agent is done, so start the app's shutdown before the sync:
    // a post-merge test run is the one place the test command would otherwise
    // race the dev server for a port or a database. kill() only sends SIGTERM
    // and returns, so this narrows that window rather than closing it — good
    // enough, since the run it protects only happens after an agent has spent
    // minutes resolving conflicts. The `finally` kill stays as the safety net
    // for every other exit path.
    app.kill();
    await syncAndPush(config, sync, state, "TESTING", attempt);
    const prMd =
      (await readWorkspaceFile(config, ".waypoint/pr.md")) ?? "Automated change by Waypoint.";
    await sync.stageEnd({
      action: "end",
      stage: "TESTING",
      attempt,
      status: "SUCCEEDED",
      sessionId: result.sessionId,
      artifacts: [
        { name: "pr.md", content: prMd },
        { name: `test-findings-${attempt}.json`, content: JSON.stringify(findings, null, 2) },
      ],
    });
    state.update({ phase: "AWAIT_STOP" });
  } finally {
    app.kill();
  }
}

/**
 * The pre-push sync (§7): bring the branch up to date with the branch the PR
 * targets while an agent is still around to deal with the fallout, so the PR
 * opens mergeable instead of landing conflicts in the user's lap.
 */
async function syncAndPush(
  config: RunnerConfig,
  sync: Syncer,
  state: StateStore,
  stage: "TESTING" | "PR_FEEDBACK",
  attempt: number,
): Promise<SyncOutcome> {
  // A crash in phase PUSH re-runs the whole testing stage as a fresh attempt.
  // The PR-feedback round keeps its own phase, so a crash re-runs that instead.
  if (stage === "TESTING") state.update({ phase: "PUSH" });
  const outcome = await syncWithDefaultBranch(config, sync);
  if (outcome === "conflicts") await resolveMergeConflicts(config, sync, state, stage, attempt);
  await pushBranch(config, sync);
  return outcome;
}

/**
 * Pick up whatever landed on the default branch since this task last looked,
 * at a point where no agent is mid-edit (the start of an implementation round,
 * the start of testing). This is how a merged PR reaches every task that is
 * still in flight: conflicts surface while they are small and an agent is about
 * to work on the code anyway, instead of all at once before the push.
 */
async function syncAtBoundary(
  config: RunnerConfig,
  sync: Syncer,
  state: StateStore,
  stage: StageName,
  attempt: number,
): Promise<void> {
  // the merge needs a clean tree; whatever is lying around belongs to the task
  await commitLeftovers(config, "chore: checkpoint before syncing with the default branch");
  const outcome = await syncWithDefaultBranch(config, sync);
  if (outcome === "conflicts") await resolveMergeConflicts(config, sync, state, stage, attempt);
}

/**
 * Hand the conflicts left by syncWithDefaultBranch to an agent, then re-check
 * the test gate — a clean merge of two correct branches can still be broken.
 *
 * Failure posture: an agent that never concludes the merge fails the task
 * (retryable), because pushing conflict markers is never acceptable. A gate
 * that stays red after {@link MERGE_GATE_CAP} rounds only warns — a mergeable
 * PR with a visible red gate beats a stuck pipeline.
 */
async function resolveMergeConflicts(
  config: RunnerConfig,
  sync: Syncer,
  state: StateStore,
  stage: StageName,
  attempt: number,
): Promise<void> {
  const defaultBranch = config.meta.project.defaultBranch;
  const conflicts = await conflictedFiles(config);
  // while the merge is in progress HEAD is still the branch tip from before it
  const preMerge = await headSha(config);

  let nudges = 0;
  let gateRounds = 0;
  // The conflict agent borrows the calling stage's run: its messages land in
  // that stage's transcript and its tokens on that stage's usage. `auxiliary`
  // keeps it from replacing the stage's session id or the user's checklist.
  await runStageAgent(config, sync, state, {
    stage,
    attempt,
    model: config.meta.models.implementation,
    effort: effortFor(config, "MERGE"),
    auxiliary: true,
    initialPrompt: renderPrompt("merge", config, {
      CONFLICT_FILES: conflicts.map((file) => `- \`${file}\``).join("\n"),
    }),
    onTurnComplete: async () => {
      // `git add` on a file that still has conflict markers in it satisfies both
      // of git's own "is the merge done" checks, so check the content too —
      // otherwise a project without a test command has nothing left to catch it.
      const unfinished =
        (await mergeInProgress(config)) || (await conflictedFiles(config)).length > 0;
      const marked = unfinished ? [] : await filesWithConflictMarkers(config, conflicts);
      if (unfinished || marked.length) {
        if (nudges < 2) {
          nudges++;
          return unfinished
            ? "The merge is still in progress. Finish it now: resolve every conflicted file (`git diff --name-only --diff-filter=U` lists what is left), `git add` each one, then `git commit --no-edit`. Do not abort the merge."
            : `The merge is committed, but conflict markers are still in the file(s) below — that content is about to be pushed. Rewrite each one into the resolution you intended (no \`<<<<<<<\`, \`=======\` or \`>>>>>>>\` lines left), then commit.\n\n${marked.map((file) => `- ${file}`).join("\n")}`;
        }
        // Put the branch back where it was. Leaving a merge commit that still
        // contains markers at HEAD would make the next sync report "up to
        // date", skip this check, and push the markers.
        await abortLeftoverMerge(config);
        if (preMerge) await resetTo(config, preMerge);
        throw new AgentError(
          unfinished
            ? `merge with origin/${defaultBranch} was left unresolved`
            : `conflict markers left in ${marked.join(", ")} after merging origin/${defaultBranch}`,
        );
      }

      // Gate first, cap second: the cap decides whether to send another round of
      // feedback, never whether to check — the agent's last fix gets verified
      // like every other one.
      const gate = await runTestGate(config);
      if (gate.ok) return null;

      gateRounds++;
      if (gateRounds >= MERGE_GATE_CAP) {
        sync.log(
          "warn",
          `the test gate is still failing ${MERGE_GATE_CAP} rounds after the merge — carrying on, check the PR`,
        );
        return null;
      }
      return `The merge is committed, but the test gate now fails. Fix the fallout from the merge — do not undo the upstream changes you just merged in.\n\n${gate.feedback}`;
    },
  });

  await commitLeftovers(config, `chore: resolve merge with ${defaultBranch}`);
}

/**
 * Which of `files` still contain conflict markers. Only the files the merge
 * itself flagged are scanned — a repo-wide search would flag anything that
 * legitimately talks about markers, this prompt file included.
 */
async function filesWithConflictMarkers(config: RunnerConfig, files: string[]): Promise<string[]> {
  const marked: string[] = [];
  for (const file of files) {
    const content = await readWorkspaceFile(config, file);
    // both ends, so a file that merely documents one marker doesn't trip it
    if (content && /^<<<<<<< /m.test(content) && /^>>>>>>> /m.test(content)) marked.push(file);
  }
  return marked;
}

async function bounceFromTesting(
  config: RunnerConfig,
  sync: Syncer,
  state: StateStore,
  findings: Findings,
  _attempt: number,
): Promise<void> {
  const cycles = state.get().testingCycles + 1;
  state.update({ testingCycles: cycles });
  if (cycles > TESTING_CYCLE_CAP) {
    await cycleCapQuestion(config, sync, state, "testing", cycles, findings);
    return;
  }
  sync.log("info", `testing requested changes (cycle ${cycles}/${TESTING_CYCLE_CAP})`);
  state.update({ pendingFindings: { source: "testing", findings }, phase: "IMPLEMENTING" });
}

// ---------------------------------------------------------------------------

async function cycleCapQuestion(
  config: RunnerConfig,
  sync: Syncer,
  state: StateStore,
  kind: "review" | "testing",
  cycles: number,
  findings: Findings,
): Promise<void> {
  const cap = kind === "review" ? REVIEW_CYCLE_CAP : TESTING_CYCLE_CAP;
  const answer = await sync.ask({
    kind: "QUESTION",
    text: `The ${kind} stage has requested changes ${cycles} times (cap ${cap}). ${findings.findings.length} findings remain. How should Waypoint proceed?`,
    contextSummary: `"${config.meta.title}" hit its ${kind} cycle cap.`,
    options: [CYCLE_CAP_OPTION_CONTINUE, CYCLE_CAP_OPTION_CANCEL],
  });
  if (/^cancel/i.test(answer)) {
    await waitForStop(sync);
    return;
  }
  // reset the local counter and run one more fix round — review findings still
  // go through the approval gate, the cap question is not a blanket approval
  if (kind === "review") {
    state.update({ reviewCycles: 0 });
    routeReviewFindings(sync, state, findings, "cycle cap reset");
    return;
  }
  state.update({
    testingCycles: 0,
    pendingFindings: { source: kind, findings },
    phase: "IMPLEMENTING",
  });
}

/** The server cancels on a "Cancel" answer; wait for the control flip. */
async function waitForStop(sync: Syncer): Promise<never> {
  for (;;) {
    if (sync.control === "stop") throw new StopRequested();
    await sleep(2000);
  }
}

/**
 * The pipeline is finished and the PR is (about to be) open. Returns "stop"
 * when the host says to exit, or "feedback" when it has revived this container
 * to work on the pull request again — review comments, or a conflict with the
 * default branch. `acceptFeedback` is false once this process has already done
 * a feedback round: the host keeps sending the same feedback until it has
 * processed the stage end, and that must not start a second round.
 */
export async function awaitStop(
  sync: Syncer,
  acceptFeedback: boolean,
): Promise<"stop" | "feedback"> {
  sync.log("info", "pipeline complete — waiting for the host to finish up");
  for (;;) {
    if (sync.control === "stop") return "stop";
    if (acceptFeedback && sync.prFeedback !== undefined) return "feedback";
    await sleep(2000);
  }
}

// ---------------------------------------------------------------------------
// PR feedback — the user commented on the open pull request, or it no longer
// merges cleanly. Fresh session: the implementation session's cache is long
// gone and its container may have been recreated, so the prompt stands alone.
// ---------------------------------------------------------------------------

export async function runPrFeedback(
  config: RunnerConfig,
  sync: Syncer,
  state: StateStore,
): Promise<void> {
  // Always taken from the host, never from state.json: the host re-sends it on
  // every sync while the task is ADDRESSING_FEEDBACK, so a restarted container
  // gets the current round's feedback rather than a stale copy.
  const feedback = await waitForPrFeedback(sync);
  const attempt = state.nextAttempt("PR_FEEDBACK");
  const model = config.meta.models.implementation;
  await sync.stageStart({ action: "start", stage: "PR_FEEDBACK", attempt, model });
  await ensureBranch(config, sync);
  // a reply left over from a round that crashed after writing it is stale —
  // it would be posted again as this round's
  await fs.rm(path.join(config.workspace, ".waypoint/pr-reply.md"), { force: true });

  let sessionId: string | undefined;
  if (feedback.trim()) {
    let gateRounds = 0;
    let askedReply = false;
    const result = await runStageAgent(config, sync, state, {
      stage: "PR_FEEDBACK",
      attempt,
      model,
      effort: effortFor(config, "PR_FEEDBACK"),
      initialPrompt: renderPrompt("pr-feedback", config, {
        PLAN: (await readWorkspaceFile(config, ".waypoint/plan.md")) ?? "(plan not available)",
        FEEDBACK: feedback,
      }),
      onTurnComplete: async () => {
        const gate = await runTestGate(config);
        const checks = gate.ok ? await runFormatAndLint(config) : gate;
        if (!checks.ok) {
          gateRounds++;
          if (gateRounds < PR_FEEDBACK_GATE_CAP) return checks.feedback;
          // same posture as the merge gate: a pushed fix with a visible red
          // check beats a pull request stuck waiting on a loop
          sync.log(
            "warn",
            `checks are still failing after ${PR_FEEDBACK_GATE_CAP} rounds — pushing anyway, check the PR`,
          );
        }
        const reply = await readWorkspaceFile(config, ".waypoint/pr-reply.md");
        if (!reply && !askedReply) {
          askedReply = true;
          return 'Write `/workspace/.waypoint/pr-reply.md` as described under "Final step", then commit anything still uncommitted.';
        }
        return null;
      },
    });
    sessionId = result.sessionId;
  } else {
    sync.log("info", "no review comments to address — syncing with the default branch");
  }

  await commitLeftovers(config, "chore: address pull request feedback");
  const outcome = await syncAndPush(config, sync, state, "PR_FEEDBACK", attempt);
  if (!feedback.trim() && (outcome === "skipped" || outcome === "up-to-date")) {
    // This round existed only to make the pull request mergeable, and it
    // changed nothing — ending it normally would have the host start the same
    // round again a minute later, forever. Fail it so a person looks.
    throw new Error(
      `the pull request does not merge cleanly, and syncing with origin/${config.meta.project.defaultBranch} did not change that (${outcome}) — resolve it on the branch by hand, then retry`,
    );
  }

  const prMd = await readWorkspaceFile(config, ".waypoint/pr.md");
  const reply = await readWorkspaceFile(config, ".waypoint/pr-reply.md");
  await sync.stageEnd({
    action: "end",
    stage: "PR_FEEDBACK",
    attempt,
    status: "SUCCEEDED",
    sessionId,
    artifacts: [
      ...(prMd ? [{ name: "pr.md", content: prMd }] : []),
      ...(reply ? [{ name: "pr-reply.md", content: reply }] : []),
    ],
  });
  // the reply is per round — a leftover would be posted again next time
  await fs.rm(path.join(config.workspace, ".waypoint/pr-reply.md"), { force: true });
  state.update({ phase: "AWAIT_STOP" });
}

async function waitForPrFeedback(sync: Syncer): Promise<string> {
  for (;;) {
    if (sync.control === "stop") throw new StopRequested();
    if (sync.prFeedback !== undefined) return sync.prFeedback;
    await sleep(2000);
  }
}

const SEVERITIES = new Set(["high", "medium", "low"]);

/**
 * Parse a findings file into the exact shape the host accepts, or say what is
 * wrong with it. Agents write this file by hand: one invented severity or a
 * missing field would otherwise be rejected by the host's schema on every
 * sync, taking the heartbeat down with it.
 */
function parseFindings(raw: string): Findings | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return `is not valid JSON (${err instanceof Error ? err.message : String(err)})`;
  }
  const doc = parsed as { verdict?: unknown; findings?: unknown } | null;
  if (doc?.verdict !== "approve" && doc?.verdict !== "request_changes") {
    return 'needs a "verdict" of "approve" or "request_changes"';
  }
  const findings: Finding[] = [];
  for (const entry of Array.isArray(doc.findings) ? doc.findings : []) {
    if (!entry || typeof entry !== "object") continue;
    const f = entry as Record<string, unknown>;
    const description = typeof f.description === "string" ? f.description.trim() : "";
    if (!description) continue;
    findings.push({
      ...(SEVERITIES.has(f.severity as string)
        ? { severity: f.severity as Finding["severity"] }
        : {}),
      // an unrecognized/missing category falls to "other", i.e. it needs approval
      category: CATEGORIES.has(f.category as FindingCategory)
        ? (f.category as FindingCategory)
        : "other",
      file: typeof f.file === "string" && f.file ? f.file : "(unspecified)",
      description,
      ...(typeof f.suggestion === "string" && f.suggestion ? { suggestion: f.suggestion } : {}),
    });
  }
  if (doc.verdict === "request_changes" && findings.length === 0) {
    return 'has a "request_changes" verdict but no finding with a "description"';
  }
  return { verdict: doc.verdict, findings };
}

/** What to tell the agent about its findings file, or null when it is usable. */
async function findingsProblem(config: RunnerConfig, relative: string): Promise<string | null> {
  const raw = await readWorkspaceFile(config, relative);
  if (!raw) return "does not exist yet";
  const parsed = parseFindings(raw);
  return typeof parsed === "string" ? parsed : null;
}

async function readFindings(
  config: RunnerConfig,
  sync: Syncer,
  relative: string,
): Promise<Findings> {
  const raw = await readWorkspaceFile(config, relative);
  const parsed = raw ? parseFindings(raw) : "does not exist";
  if (typeof parsed !== "string") return parsed;
  // the agent was nudged twice and still left nothing usable — say so, since
  // carrying on as "approved" is otherwise indistinguishable from a clean pass
  sync.log("warn", `${relative} ${parsed} — treating the stage as approved with no findings`);
  return { verdict: "approve", findings: [] };
}

const CATEGORIES = new Set<FindingCategory>([
  "readability",
  "simplification",
  "bug",
  "edge_case",
  "deviation",
  "other",
]);

function parseCheckboxes(markdown: string): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  for (const line of markdown.split("\n")) {
    const match = /^\s*[-*]\s*\[([ xX])\]\s+(.+)$/.exec(line);
    if (match?.[2]) {
      items.push({
        text: match[2].trim(),
        state: match[1] === " " ? "pending" : "completed",
      });
    }
  }
  return items;
}

/**
 * How long the app gets to answer on its ready URL. A compose stack may still
 * be building images and waiting on a database the first time it comes up.
 */
const READY_TIMEOUT_MS = (): number => (dockerEnabled() ? 600_000 : 120_000);

async function waitForReady(url: string | null, timeoutMs: number): Promise<boolean> {
  if (!url) {
    await sleep(5000); // no ready URL configured — grace period only
    return true;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.status < 500) return true;
    } catch {
      /* not up yet */
    }
    await sleep(2000);
  }
  return false;
}
