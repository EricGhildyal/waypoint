import { describe, expect, test } from "bun:test";
import { parseEnv } from "./parse-env";

describe("parseEnv", () => {
  test("reads plain, exported, quoted and commented lines", () => {
    const { entries, skipped } = parseEnv(
      [
        "# database",
        "DATABASE_URL=postgres://u:p@db:5432/app?sslmode=disable",
        "export API_KEY = sk-123   # trailing comment",
        "",
        `GREETING="hello \\"world\\"\\nbye"`,
        "LITERAL='keep $HOME and \\n as is'",
        "HASH=abc#def",
        "lower_case=ok",
      ].join("\r\n"),
    );
    expect(skipped).toEqual([]);
    expect(Object.fromEntries(entries)).toEqual({
      DATABASE_URL: "postgres://u:p@db:5432/app?sslmode=disable",
      API_KEY: "sk-123",
      GREETING: 'hello "world"\nbye',
      LITERAL: "keep $HOME and \\n as is",
      HASH: "abc#def",
      lower_case: "ok",
    });
  });

  test("a quoted value can span lines", () => {
    const { entries } = parseEnv('KEY="-----BEGIN-----\nabc\n-----END-----"\nNEXT=1');
    expect(entries).toEqual([
      ["KEY", "-----BEGIN-----\nabc\n-----END-----"],
      ["NEXT", "1"],
    ]);
  });

  test("a repeated key keeps its last value", () => {
    expect(parseEnv("A=1\nB=2\nA=3").entries).toEqual([
      ["B", "2"],
      ["A", "3"],
    ]);
  });

  test("unusable lines are reported with their line number", () => {
    const { entries, skipped } = parseEnv(
      'EMPTY=\nQUOTED_EMPTY=""\njust words\n1BAD=x\nOPEN="never\nGOOD=1',
    );
    expect(entries).toEqual([]);
    expect(skipped.map((s) => [s.line, s.text])).toEqual([
      [1, "EMPTY"],
      [2, "QUOTED_EMPTY"],
      [3, "just words"],
      [4, "1BAD"],
      [5, "OPEN"],
    ]);
  });
});
