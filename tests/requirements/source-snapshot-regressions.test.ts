import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "vitest";

const TOOL = resolve("tools/requirements/src/main.ts");
const TSX = resolve("node_modules/tsx/dist/cli.mjs");

describe("requirement source regressions", () => {
  // @verifies requirements.source_snapshot.staged.missing_blobs
  it("skips missing staged blobs", () => {
    const cwd = createFixtureRepo();
    writeValidRequirementFiles(cwd);
    runTool(cwd, ["fmt-agents"]);
    runGit(cwd, ["add", "."]);
    runGit(cwd, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "seed"]);

    writeFileSync(join(cwd, "src/intent.ts"), "export const pending = true;\n");
    runGit(cwd, ["add", "-N", "src/intent.ts"]);

    runTool(cwd, ["check", "--staged"]);
  }, 120_000);
});

function createFixtureRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "glossa-req-"));
  mkdirSync(join(cwd, "src"), { recursive: true });
  mkdirSync(join(cwd, "tests"), { recursive: true });
  runGit(cwd, ["init"]);
  return cwd;
}

function writeValidRequirementFiles(cwd: string): void {
  writeFileSync(
    join(cwd, "src/main.ts"),
    [
      "// @behavior demo The demo command has verified behavior.",
      "// @behavior demo.feature The demo command returns the configured value.",
      "export function demoValue(): string {",
      "  return \"demo\";",
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(cwd, "tests/main.test.ts"),
    [
      "import { expect, it } from \"vitest\";",
      "",
      "// @verifies demo.feature",
      "it(\"checks demo\", () => {",
      "  expect(true).toBe(true);",
      "});",
      "",
    ].join("\n"),
  );
}

function runTool(cwd: string, args: string[]): string {
  return execFileSync(process.execPath, [TSX, TOOL, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, TMPDIR: "/tmp" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
}
