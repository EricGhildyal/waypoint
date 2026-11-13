import { describe, expect, test } from "bun:test";
import { epochToIso, usageWindowsFrom, utilizationPercent } from "./usage";

describe("usageWindowsFrom", () => {
  // captured from Claude Code 2.1.322
  const unified = {
    status: "allowed",
    resetsAt: 1794531000,
    rateLimitType: "five_hour",
    unifiedWindows: {
      five_hour: { utilization: 0.46, resetsAt: 1794531000, status: "allowed" },
      seven_day: { utilization: 0.08, resetsAt: 1795028400, status: "allowed" },
      seven_day_overage_included: { utilization: 0.16, resetsAt: 1795028400, status: "allowed" },
    },
  };

  test("reads every window from unifiedWindows, as percentages", () => {
    expect(usageWindowsFrom(unified)).toEqual([
      { type: "five_hour", utilization: 46, resetsAt: "2026-11-13T00:50:00.000Z" },
      { type: "seven_day", utilization: 8, resetsAt: "2026-11-18T19:00:00.000Z" },
      { type: "seven_day_overage_included", utilization: 16, resetsAt: "2026-11-18T19:00:00.000Z" },
    ]);
  });

  test("falls back to the single binding window of an older SDK's warning", () => {
    // captured from Claude Code 2.1.220
    const warning = {
      status: "allowed_warning",
      resetsAt: 1785790200,
      rateLimitType: "five_hour",
      utilization: 0.99,
      surpassedThreshold: 0.9,
    };
    expect(usageWindowsFrom(warning)).toEqual([
      { type: "five_hour", utilization: 99, resetsAt: "2026-08-03T20:50:00.000Z" },
    ]);
  });

  test("an event with no utilization anywhere yields nothing", () => {
    expect(usageWindowsFrom({ rateLimitType: "five_hour", resetsAt: 1786219200 })).toEqual([]);
    expect(usageWindowsFrom({})).toEqual([]);
  });

  test("malformed window entries are skipped, not thrown on", () => {
    const info = { unifiedWindows: { five_hour: null, seven_day: { utilization: "high" }, x: 3 } };
    expect(usageWindowsFrom(info)).toEqual([]);
  });

  test("a window without a reset time is still reported", () => {
    const info = { unifiedWindows: { overage: { utilization: 0.5 } } };
    expect(usageWindowsFrom(info)).toEqual([
      { type: "overage", utilization: 50, resetsAt: undefined },
    ]);
  });
});

describe("conversions", () => {
  test("utilization is a fraction and becomes a percentage", () => {
    expect(utilizationPercent(0.005)).toBe(0.5);
    expect(utilizationPercent(1)).toBe(100);
  });

  test("reset times are read as seconds or milliseconds", () => {
    expect(epochToIso(1794531000)).toBe("2026-11-13T00:50:00.000Z");
    expect(epochToIso(1794531000000)).toBe("2026-11-13T00:50:00.000Z");
    expect(epochToIso(0)).toBeNull();
    expect(epochToIso(undefined)).toBeNull();
  });
});
