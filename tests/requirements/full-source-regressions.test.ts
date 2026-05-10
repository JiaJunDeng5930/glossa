import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const TOOL = resolve("tools/requirements/src/main.ts");
const TSX = resolve("node_modules/tsx/dist/cli.mjs");

describe("requirement full source regressions", () => {
  // @verifies requirements.change_anchoring.full_source
  // @verifies requirements.change_anchoring.full_source.lines
  // @verifies requirements.change_anchoring.full_source.lines.dedupe
  // @verifies requirements.change_anchoring.full_source.required_tags
  // @verifies requirements.change_anchoring.comment_line_skip.standalone_match
  it("rejects an unanchored side effect in full source mode", () => {
    const cwd = createFixtureRepo();
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
    writeFileSync(
      join(cwd, "tests/main.test.ts"),
      [
        "import { expect, it } from \"vitest\";",
        "",
        "// @verifies demo",
        "it(\"checks demo\", () => {",
        "  expect(true).toBe(true);",
        "});",
        "",
      ].join("\n"),
    );
    runTool(cwd, ["fmt-agents"]);

    let stderr = "";
    try {
      runTool(cwd, ["check", "--all"]);
    } catch (error) {
      stderr = String((error as { stderr?: Buffer }).stderr);
    }

    expect(stderr).toContain("src/main.ts:3 missing-requirement-anchor");
  }, 20_000);
});

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
