import { describe, expect, test } from "bun:test";
import {
  ACTIVE_STATUSES,
  ALLOWED_TRANSITIONS,
  RUNNING_STAGE_STATUSES,
  STAGE_TO_STATUS,
} from "./constants";

describe("ALLOWED_TRANSITIONS", () => {
  test("DONE and CANCELLED are terminal", () => {
    expect(ALLOWED_TRANSITIONS.DONE).toEqual([]);
    expect(ALLOWED_TRANSITIONS.CANCELLED).toEqual([]);
  });

  test("an opened pull request waits for review instead of finishing the task", () => {
    expect(ALLOWED_TRANSITIONS.OPENING_PR).toContain("PR_OPEN");
    expect(ALLOWED_TRANSITIONS.OPENING_PR).not.toContain("DONE");
  });

  test("an open pull request can be merged, closed, or sent back for changes", () => {
    const targets: string[] = ALLOWED_TRANSITIONS.PR_OPEN.toSorted();
    expect(targets).toEqual(["ADDRESSING_FEEDBACK", "CANCELLED", "DONE"]);
  });

  test("a feedback round returns to the open pull request, never straight to DONE", () => {
    expect(ALLOWED_TRANSITIONS.ADDRESSING_FEEDBACK).toContain("PR_OPEN");
    expect(ALLOWED_TRANSITIONS.ADDRESSING_FEEDBACK).not.toContain("DONE");
  });

  // Resume, retry, answers and rate-limit recovery all go back to
  // STAGE_TO_STATUS[currentStage]. A stage whose status is not reachable from
  // one of these would strand its task there.
  test("every stage's status can be returned to after an interruption", () => {
    for (const status of Object.values(STAGE_TO_STATUS)) {
      for (const interrupted of ["PAUSED", "NEEDS_INPUT", "RATE_LIMITED", "FAILED"] as const) {
        expect(ALLOWED_TRANSITIONS[interrupted]).toContain(status);
      }
    }
  });

  test("every status can itself be interrupted while its stage runs", () => {
    for (const status of Object.values(STAGE_TO_STATUS)) {
      for (const to of ["PAUSED", "NEEDS_INPUT", "RATE_LIMITED", "FAILED", "CANCELLED"] as const) {
        expect(ALLOWED_TRANSITIONS[status]).toContain(to);
      }
    }
  });
});

describe("status groups", () => {
  test("a feedback round holds a slot and gets a running container", () => {
    expect(ACTIVE_STATUSES).toContain("ADDRESSING_FEEDBACK");
    expect(RUNNING_STAGE_STATUSES).toContain("ADDRESSING_FEEDBACK");
  });

  test("a task waiting on the human holds no slot", () => {
    for (const waiting of ["PR_OPEN", "NEEDS_INPUT", "AWAITING_PLAN_APPROVAL"] as const) {
      expect(ACTIVE_STATUSES).not.toContain(waiting);
      expect(RUNNING_STAGE_STATUSES).not.toContain(waiting);
    }
  });

  test("every status with a running agent holds a slot", () => {
    for (const status of RUNNING_STAGE_STATUSES) expect(ACTIVE_STATUSES).toContain(status);
  });
});
