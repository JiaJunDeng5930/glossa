import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const TOOL = resolve("tools/requirements/src/main.ts");
const TSX = resolve("node_modules/tsx/dist/cli.mjs");

describe("requirement anchor regressions", () => {
  // @verifies requirements.change_anchoring.local_anchor.inner_scope
  // @verifies requirements.change_anchoring.local_anchor.inner_scope.broad_declaration_line
  // @verifies requirements.change_anchoring.local_anchor.inner_scope.exact_target_kinds
  // @verifies requirements.change_anchoring.local_anchor.inner_scope.exact_target_kinds.declaration_list
  // @verifies requirements.change_anchoring.local_anchor.inner_scope.structure_test_span
  // @verifies requirements.change_anchoring.comment_line_skip
  it("rejects inner side effects covered only by broad or inline anchors", () => {
    const cwd = createFixtureRepo();
    writeSeed(cwd);
    runTool(cwd, ["fmt-agents"]);
    runGit(cwd, ["add", "."]);
    runGit(cwd, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "seed"]);

    writeFileSync(
      join(cwd, "src/main.ts"),
      [
        "// @behavior demo The demo command has verified behavior.",
        "export function demo(): void {",
        "  localStorage.setItem(\"demo\", \"value\");",
        "}",
        "",
      ].join("\n"),
    );
    runGit(cwd, ["add", "src/main.ts"]);
    expect(checkStagedStderr(cwd)).toContain("src/main.ts:3 missing-requirement-anchor");

    writeFileSync(
      join(cwd, "src/main.ts"),
      [
        "// @behavior demo The demo command has verified behavior.",
        "export function demo(): void {",
        "  localStorage.setItem(\"demo\", \"value\"); // @behavior demo.save The save branch writes browser storage.",
        "}",
        "",
      ].join("\n"),
    );
    runGit(cwd, ["add", "src/main.ts"]);
    expect(checkStagedStderr(cwd)).toContain("src/main.ts:3 missing-requirement-anchor");
  }, 20_000);
});

function writeSeed(cwd: string): void {
  writeFileSync(
    join(cwd, "src/main.ts"),
    [
      "// @behavior demo The demo command has verified behavior.",
      "export function demo(): void {",
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(cwd, "tests/main.test.ts"),
    [
      "import { expect, it } from \"vitest\";",
      "",
      "// @verifies demo",
      "it(\"keeps the demo contract\", () => {",
      "  expect(true).toBe(true);",
      "});",
      "",
    ].join("\n"),
  );
}

function checkStagedStderr(cwd: string): string {
  try {
    runTool(cwd, ["check", "--staged"]);
    return "";
  } catch (error) {
    return String((error as { stderr?: Buffer }).stderr);
  }
}

function createFixtureRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "glossa-req-"));
  mkdirSync(join(cwd, "src"), { recursive: true });
  mkdirSync(join(cwd, "tests"), { recursive: true });
  runGit(cwd, ["init"]);
  return cwd;
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
