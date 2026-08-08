import { promises as fs } from "node:fs";
import path from "node:path";
import { AgentError, runStageAgent } from "./agent";
import type { RunnerConfig } from "./config";
import { runFormatAndLint, runTestGate } from "./coverage";
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
  TESTING_CYCLE_CAP,
  parseFindingSelection,
} from "./types";
import {
  commitLeftovers,
  conflictedFiles,
  ensureBranch,
  mergeInProgress,
  pushBranch,
  readWorkspaceFile,
  syncWithDefaultBranch,
} from "./workspace";

const IMPL_GATE_CAP = 10;
const MERGE_GATE_CAP = 3;

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
    initialPrompt: prompt,
    resumeSessionId,
    freshPrompt,
    onTurnComplete: async () => {
      const plan = await readWorkspaceFile(config, ".waypoint/plan.md");
      if (!plan && nudges < 2) {
        nudges++;
        return "You have not written /workspace/.waypoint/plan.md yet. Write the complete plan there now — it is the only output of this stage.";
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
  const plan = (await readWorkspaceFile(config, ".waypoint/plan.md")) ?? "(plan missing)";
  const answer = await sync.ask({
    kind: "PLAN_APPROVAL",
    text: plan,
    contextSummary: `The plan for "${config.meta.title}" is ready. Reply "approve" to start implementation, or reply with revision notes.`,
  });

  if (/^approve/i.test(answer.trim())) {
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

  const pending = state.get().pendingFindings;
  const priorSession = state.get().sessions.IMPLEMENTATION;
  const plan = (await readWorkspaceFile(config, ".waypoint/plan.md")) ?? "";
  const stagePrompt = renderPrompt("implementation", config, { PLAN: plan });
  const fixup = pending && priorSession ? pending : undefined;
  const prompt = fixup ? fixupPrompt(fixup) : stagePrompt;
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
    : undefined;

  let gateRounds = 0;
  let askedPrMd = false;

  const result = await runStageAgent(config, sync, state, {
    stage: "IMPLEMENTATION",
    attempt,
    model,
    initialPrompt: prompt,
    resumeSessionId: fixup ? priorSession : undefined,
    freshPrompt,
    onTurnComplete: async () => {
      // Loop: tests green AND changed-line coverage ≥ bar → then format+lint →
      // then pr.md — each failure resumes the same session with feedback (§7).
      gateRounds++;
      if (gateRounds > IMPL_GATE_CAP) {
        const answer = await sync.ask({
          kind: "QUESTION",
          text: `Implementation has been through ${IMPL_GATE_CAP} verification rounds without getting tests green at the coverage bar. Keep going, or cancel?`,
          contextSummary: `"${config.meta.title}" can't clear its test/coverage gate after ${IMPL_GATE_CAP} rounds.`,
          options: [CYCLE_CAP_OPTION_CONTINUE, CYCLE_CAP_OPTION_CANCEL],
        });
        if (/^cancel/i.test(answer)) {
          await waitForStop(sync);
        }
        gateRounds = 0;
      }

      sync.log(
        "info",
        config.meta.project.testCommand
          ? "running test + coverage gate"
          : "no test command configured — skipping test + coverage gate",
      );
      const gate = await runTestGate(config);
      if (!gate.ok) return gate.feedback;

      const style = await runFormatAndLint(config);
      if (!style.ok) return style.feedback;

      const prMd = await readWorkspaceFile(config, ".waypoint/pr.md");
      if (!prMd && !askedPrMd) {
        askedPrMd = true;
        return "All checks pass. Final step: write /workspace/.waypoint/pr.md — a short summary of the changes plus any special-implementation-detail notes tied to the original prompt, nothing else. Then make a final commit if anything is uncommitted.";
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

function fixupPrompt(pending: { source: "review" | "testing"; findings: Findings }): string {
  const items = pending.findings.findings
    .map(
      (f, i) =>
        `${i + 1}. [${f.severity ?? "finding"} · ${f.category}] ${f.file}: ${f.description}${f.suggestion ? `\n   Suggestion: ${f.suggestion}` : ""}`,
    )
    .join("\n");
  return [
    pending.source === "review"
      ? "The code review requested changes and the user approved the findings below. Address every one of them, keeping the plan's intent, and change nothing else — findings the user declined have already been dropped from this list. Commit as you go."
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
    initialPrompt: renderPrompt("review", config, { PLAN: plan }),
    onTurnComplete: async () => {
      const findings = await readWorkspaceFile(config, ".waypoint/review-findings.json");
      if (!findings && nudges < 2) {
        nudges++;
        return 'You have not written /workspace/.waypoint/review-findings.json yet. Write it now with the exact contract: { "verdict": "approve" | "request_changes", "findings": [{ "severity", "category", "file", "description", "suggestion" }] } — "category" is required on every finding.';
      }
      return null;
    },
  });

  const findings = await readFindings(config, ".waypoint/review-findings.json");
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
    sync.log(
      "info",
      project.testCommand
        ? "running test + coverage gate"
        : "no test command configured — skipping test + coverage gate",
    );
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
    await syncAndPush(config, sync, state, attempt);
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

  sync.log("info", `starting app: ${project.runCommand}`);
  const app = spawnDetached(project.runCommand, {
    cwd: config.workspace,
    onLine: (line) => sync.log("debug", `[app] ${line}`),
  });

  try {
    const ready = await waitForReady(project.runReadyUrl, 120_000);
    if (!ready) {
      // readiness timeout is a TEST finding, not an infra failure (§7)
      const findings: Findings = {
        verdict: "request_changes",
        findings: [
          {
            severity: "high",
            category: "bug",
            file: "(run)",
            description: `The app failed to become ready at ${project.runReadyUrl} within 120s when started with \`${project.runCommand}\`. Log tail:\n${tail(app.output(), 3000)}`,
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
      playwright: true,
      initialPrompt: renderPrompt("testing", config, {
        PLAN: (await readWorkspaceFile(config, ".waypoint/plan.md")) ?? "",
        APP_URL: project.runReadyUrl ?? "http://localhost:3000",
      }),
      onTurnComplete: async () => {
        const findings = await readWorkspaceFile(config, ".waypoint/test-findings.json");
        if (!findings && nudges < 2) {
          nudges++;
          return 'You have not written /workspace/.waypoint/test-findings.json yet. Write it now: { "verdict": "approve" | "request_changes", "findings": [{ "file", "description", "suggestion" }] } — and make sure the Playwright specs for validated flows are committed.';
        }
        return null;
      },
    });

    const findings = await readFindings(config, ".waypoint/test-findings.json");
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
    await syncAndPush(config, sync, state, attempt);
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
  attempt: number,
): Promise<void> {
  state.update({ phase: "PUSH" });
  const outcome = await syncWithDefaultBranch(config, sync);

  if (outcome === "conflicts") {
    // Deliberate simplification: the conflict agent runs as part of the TESTING
    // stage run, so it shares that run's identity. Its session id overwrites
    // sessions.TESTING; its messages are appended to the same
    // testing-<attempt>.jsonl transcript the testing agent wrote (expect two
    // sessions in one file); the re-sent stageStart carries the implementation
    // model, so the host shows that TESTING run attributed to it; the fresh
    // session clears the checklist tracker, so the testing agent's checklist in
    // the UI is replaced by the merge agent's; and in the skipTesting path,
    // whose stageEnd sends no sessionId, the stage run ends up pointing at the
    // merge session. All harmless: a crash in phase PUSH re-runs the whole
    // testing stage as a fresh attempt anyway, and the leftover-merge abort is
    // what makes that re-entry safe.
    await resolveMergeConflicts(config, sync, state, attempt);
  }
  await pushBranch(config, sync);
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
  attempt: number,
): Promise<void> {
  const defaultBranch = config.meta.project.defaultBranch;
  const conflicts = await conflictedFiles(config);

  let nudges = 0;
  let gateRounds = 0;
  await runStageAgent(config, sync, state, {
    stage: "TESTING",
    attempt,
    model: config.meta.models.implementation,
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
          `the test gate is still failing ${MERGE_GATE_CAP} rounds after the merge — proceeding with the push, check the PR`,
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

export async function awaitStop(sync: Syncer): Promise<void> {
  sync.log("info", "pipeline complete — waiting for the host to finish up");
  try {
    await waitForStop(sync);
  } catch (err) {
    if (err instanceof StopRequested) return;
    throw err;
  }
}

async function readFindings(config: RunnerConfig, relative: string): Promise<Findings> {
  const raw = await readWorkspaceFile(config, relative);
  if (!raw) return { verdict: "approve", findings: [] };
  try {
    const parsed = JSON.parse(raw) as Findings;
    if (parsed.verdict !== "approve" && parsed.verdict !== "request_changes") {
      return { verdict: "approve", findings: [] };
    }
    // an unrecognized/missing category falls to "other", i.e. it needs approval
    const findings = parsed.findings ?? [];
    for (const f of findings) {
      if (!CATEGORIES.has(f.category)) f.category = "other";
    }
    return { verdict: parsed.verdict, findings };
  } catch {
    return { verdict: "approve", findings: [] };
  }
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
