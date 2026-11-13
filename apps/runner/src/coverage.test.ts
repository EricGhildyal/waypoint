import { describe, expect, test } from "bun:test";
import { normalizeLcov } from "./coverage";

describe("normalizeLcov", () => {
  const files = new Set(["/ws/frontend/src/a.ts", "/ws/shared/b.ts"]);
  const exists = (file: string) => files.has(file);
  const sf = (path: string) =>
    normalizeLcov(`TN:\nSF:${path}\nDA:1,1\nend_of_record\n`, "/ws", "/ws/frontend", exists);

  test("paths relative to the suite's folder become repository-relative", () => {
    expect(sf("src/a.ts")).toBe("TN:\nSF:frontend/src/a.ts\nDA:1,1\nend_of_record\n");
  });

  test("absolute paths become repository-relative", () => {
    expect(sf("/ws/frontend/src/a.ts")).toContain("SF:frontend/src/a.ts\n");
  });

  test("a path that is already repository-relative is kept", () => {
    expect(sf("shared/b.ts")).toContain("SF:shared/b.ts\n");
  });

  test("a suite at the repository root changes nothing", () => {
    const report = "SF:frontend/src/a.ts\nDA:1,1\nend_of_record\n";
    expect(normalizeLcov(report, "/ws", "/ws", exists)).toBe(report);
  });
});
