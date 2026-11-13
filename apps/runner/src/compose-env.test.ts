import { describe, expect, test } from "bun:test";
import { composeEnvFiles, envValue } from "./compose-env";

describe("composeEnvFiles", () => {
  test("finds every form an env_file can take", () => {
    const compose = `
services:
  a:
    env_file: .env
  b:
    env_file:
      - ./backend/.env.local   # comment
      - "shared.env"
    environment:
      - NOT_A_FILE=1
  c:
    env_file:
      - path: ./frontend/.env.local
        required: false
      - path: ./backend/.env.local
  d:
    env_file: [one.env, "two.env"]
  e:
    env_file:
      - \${ENV_DIR}/x.env
`;
    expect(composeEnvFiles(compose)).toEqual([
      ".env",
      "./backend/.env.local",
      "shared.env",
      "./frontend/.env.local",
      "one.env",
      "two.env",
    ]);
  });

  test("a compose file without env files names none", () => {
    expect(composeEnvFiles("services:\n  db:\n    image: postgres\n")).toEqual([]);
  });
});

describe("envValue", () => {
  test("plain values stay bare, the rest are quoted", () => {
    expect(envValue("postgres://u:p@db:5432/x")).toBe("postgres://u:p@db:5432/x");
    expect(envValue("two words & $HOME")).toBe("'two words & $HOME'");
    expect(envValue("it's $5\nnext")).toBe('"it\'s \\$5\\nnext"');
    expect(envValue("")).toBe("");
  });
});
