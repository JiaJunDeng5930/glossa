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
  // @verifies requirements.change_anchoring.local_anchor.full_source_owner_span
  it("rejects an unanchored side effect in full source mode", () => {
    const cwd = createFixtureRepo();
    writeFileSync(
      join(cwd, "src/main.ts"),
      [
        "function demo(): void {",
        "  localStorage.setItem(\"demo\", \"value\");",
        "}",
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

    expect(stderr).toContain("src/main.ts:2 missing-requirement-anchor");
  }, 120_000);

  // @verifies requirements.change_anchoring.full_source.required_tags
  // @verifies requirements.change_anchoring.full_source.type_shapes
  // @verifies requirements.change_anchoring.local_anchor.type_member_target
  it("allows full source type member contracts to use their owner declaration anchor", () => {
    const cwd = createFixtureRepo();
    writeFileSync(
      join(cwd, "src/main.ts"),
      [
        "// @constraint demo Public records expose one stable contract surface.",
        "export interface DemoRecord {",
        "  id: string;",
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

    expect(runTool(cwd, ["check", "--all"])).toBe("");
  }, 120_000);

  // @verifies requirements.change_anchoring.local_anchor.full_source_contract
  // @verifies requirements.change_anchoring.full_source.required_tags
  it("allows full source contracts to use leading module contract comments", () => {
    const cwd = createFixtureRepo();
    writeFileSync(
      join(cwd, "src/main.ts"),
      [
        "// @constraint demo Public record contracts share the module requirement.",
        "// @intent demo.shape The demo shape keeps examples compact.",
        "export interface DemoRecord {",
        "  id: string;",
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

    expect(runTool(cwd, ["check", "--all"])).toBe("");
  }, 120_000);

  // @verifies requirements.change_anchoring.changed_categories.safety
  // @verifies requirements.change_anchoring.full_source.required_tags
  it("does not treat project word tokens as credential safety rules", () => {
    const cwd = createFixtureRepo();
    writeFileSync(
      join(cwd, "src/main.ts"),
      [
        "// @constraint demo Public helpers expose token text without credential handling.",
        "export function surfaceForToken(token: { surface: string }): string {",
        "  return token.surface;",
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

    expect(runTool(cwd, ["check", "--all"])).toBe("");
  }, 120_000);
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
