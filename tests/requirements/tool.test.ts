import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const TOOL = resolve("tools/requirements/src/main.ts");
const TSX = resolve("node_modules/tsx/dist/cli.mjs");

describe("requirement automation tool", () => {
  // @verifies requirements.commands.command The test verifies that the command parser accepts the public help command.
  // @verifies requirements.commands.help The test verifies that help output lists the public requirement commands.
  // @verifies requirements.commands.option The test verifies that public help describes staged and base comparison options.
  it("prints public help", () => {
    const output = runTool(process.cwd(), ["help"]);

    expect(output).toContain("Usage: tsx tools/requirements/src/main.ts");
  }, 20_000);

  // @verifies requirements.snapshots.worktree The test verifies that the worktree command can scan editable source files.
  // @verifies requirements.snapshots.staged The test verifies that the staged command can read the Git index.
  // @verifies requirements.snapshots.sources The test verifies that source filtering keeps the tool focused on editable TypeScript files.
  // @verifies requirements.protocol.registry The test verifies that registry construction is exercised by the scan command.
  // @verifies requirements.protocol.comments.discovery The test verifies that TypeScript comment ranges are consumed by the scan command.
  // @verifies requirements.protocol.comments.normalization The test verifies that line comments are normalized into requirement records.
  // @verifies requirements.protocol.comments.sentence The test verifies that single-sentence comments pass the scanner.
  // @verifies requirements.protocol.binding.nodes The test verifies that syntax nodes are bound during scan output.
  // @verifies requirements.protocol.binding.kinds The test verifies that declarations can own requirement comments.
  // @verifies requirements.records.target.kind The test verifies that bound target kinds appear in scan output.
  // @verifies requirements.protocol.binding.first_code The test verifies that file-level requirements can bind before code.
  // @verifies requirements.protocol.binding.trivia The test verifies that comment trivia can appear before a target node.
  // @verifies requirements.protocol.validation.ancestors The test verifies that declared requirement ancestors are accepted.
  // @verifies requirements.protocol.validation.leaf The test verifies that leaf requirements can be linked by verification comments.
  // @verifies requirements.protocol.validation.tests The test verifies that verification comments can live in Vitest files.
  // @verifies requirements.index.default The test verifies that index generation has a fallback AGENTS body.
  // @verifies requirements.index.index The test verifies that index generation emits requirement rows.
  // @verifies requirements.index.parent The test verifies that dotted parent relationships feed index rows.
  // @verifies requirements.index.check The test verifies that the check command compares AGENTS.md with generated output.
  // @verifies requirements.index.extract The test verifies that generated index markers can be read by the checker.
  // @verifies requirements.enforcement.check The test verifies that shared diff checking accepts anchored staged changes.
  // @verifies requirements.enforcement.anchor The test verifies that staged checking accepts local anchors for changed lines.
  // @verifies requirements.diagnostics.scan_output The test verifies that scan output includes discovered requirement records.
  // @verifies requirements.snapshots.git The test verifies that the tool can invoke Git-backed commands.
  // @verifies requirements.diagnostics.path The test verifies that path normalization appears in scan output.
  // @verifies requirements.diagnostics.line_number The test verifies that source locations appear in scan output.
  // @verifies requirements.diagnostics.comment_location The test verifies that diagnostics carry source file and line context.
  it("formats AGENTS.md and checks a valid staged requirement snapshot", () => {
    const cwd = createFixtureRepo();
    writeValidRequirementFiles(cwd);

    runGit(cwd, ["add", "."]);
    runTool(cwd, ["fmt-agents"]);
    runGit(cwd, ["add", "AGENTS.md"]);

    const scan = runTool(cwd, ["scan"]);
    expect(scan).toContain("src/main.ts:1 @behavior demo -> file@1");
    expect(scan).toContain("InterfaceDeclaration");

    runTool(cwd, ["check"]);
    runTool(cwd, ["check", "--staged"]);

    const agents = readFileSync(join(cwd, "AGENTS.md"), "utf8");
    expect(agents).toContain("|demo.feature|demo.feature.{}");
  }, 20_000);

  // @verifies requirements.enforcement.parse The test verifies that staged checking can parse Git diff hunks.
  // @verifies requirements.enforcement.classify The test verifies that staged checking classifies forced-anchor categories.
  // @verifies requirements.enforcement.type_member The test verifies that type member changes remain visible to contract and state-policy checks.
  // @verifies requirements.enforcement.type_member_export The test verifies that exported type members are treated as public contract changes.
  // @verifies requirements.enforcement.type_member_export_modifier The test verifies that export modifiers mark type-member owners as public contracts.
  // @verifies requirements.enforcement.group The test verifies that staged checking groups anchors by file path.
  // @verifies requirements.enforcement.rule The test verifies that staged checking emits stable missing-anchor rules.
  // @verifies requirements.diagnostics.compiler_output The test verifies that diagnostic output stays compiler-style.
  it("rejects an unanchored staged type-member state change", () => {
    const cwd = createFixtureRepo();
    writeValidRequirementFiles(cwd);
    runTool(cwd, ["fmt-agents"]);
    runGit(cwd, ["add", "."]);
    runGit(cwd, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "seed"]);

    writeFileSync(
      join(cwd, "src/main.ts"),
      [
        "// @behavior demo The module exposes a demo feature with a verified contract.",
        "// @behavior demo.feature The function returns the configured demo value.",
        "export function demoValue(): string {",
        "  return \"demo\";",
        "}",
        "",
        "// @intent demo.contract The interface defines the public demo state contract.",
        "// @constraint demo.contract.shape The interface exposes a demo state contract with verified members.",
        "export interface DemoState {",
        "  // @constraint demo.contract.value The value member exposes the configured demo value.",
        "  value: string;",
        "  status: \"ready\" | \"pending\";",
        "}",
        "",
      ].join("\n"),
    );
    runGit(cwd, ["add", "src/main.ts"]);

    let stderr = "";
    try {
      runTool(cwd, ["check", "--staged"]);
    } catch (error) {
      stderr = String((error as { stderr?: Buffer }).stderr);
    }

    expect(stderr).toContain("src/main.ts:12 missing-requirement-anchor");
  }, 20_000);

  // @verifies requirements.enforcement.classify The test verifies that state-shaped object members and literals require local anchors.
  it("rejects unanchored staged state literals before property skipping", () => {
    const cwd = createFixtureRepo();
    writeFileSync(
      join(cwd, "src/main.ts"),
      [
        "export const config = {",
        "  status: \"ready\",",
        "};",
        "export const states = [",
        "  \"pending\",",
        "];",
        "",
      ].join("\n"),
    );
    runTool(cwd, ["fmt-agents"]);
    runGit(cwd, ["add", "."]);
    runGit(cwd, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "seed"]);

    writeFileSync(
      join(cwd, "src/main.ts"),
      [
        "export const config = {",
        "  status: \"error\",",
        "};",
        "export const states = [",
        "  \"hidden\",",
        "];",
        "",
      ].join("\n"),
    );
    runGit(cwd, ["add", "src/main.ts"]);

    let stderr = "";
    try {
      runTool(cwd, ["check", "--staged"]);
    } catch (error) {
      stderr = String((error as { stderr?: Buffer }).stderr);
    }

    expect(stderr).toContain("src/main.ts:2 missing-requirement-anchor");
    expect(stderr).toContain("src/main.ts:5 missing-requirement-anchor");
  }, 20_000);

  // @verifies requirements.enforcement.parse The test verifies that staged checking records deletion-only hunks as changed lines.
  // @verifies requirements.enforcement.old_blob The test verifies that staged checking loads deleted file content for syntax context.
  // @verifies requirements.enforcement.old_comments The test verifies that staged checking binds comments from the deleted-line source snapshot.
  // @verifies requirements.records.hunk_line.old_path The test verifies that deleted-file hunks retain their old source path.
  // @verifies requirements.records.hunk_line.deleted The test verifies that deleted hunks are marked for anchor diagnostics.
  it("rejects an unanchored deletion-only side effect change", () => {
    const cwd = createFixtureRepo();
    writeFileSync(
      join(cwd, "src/main.ts"),
      [
        "export function saveValue(): void {",
        "  localStorage.setItem(\"demo\", \"value\");",
        "}",
        "",
      ].join("\n"),
    );
    runTool(cwd, ["fmt-agents"]);
    runGit(cwd, ["add", "."]);
    runGit(cwd, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "seed"]);

    writeFileSync(
      join(cwd, "src/main.ts"),
      [
        "export function saveValue(): void {",
        "}",
        "",
      ].join("\n"),
    );
    runGit(cwd, ["add", "src/main.ts"]);

    let stderr = "";
    try {
      runTool(cwd, ["check", "--staged"]);
    } catch (error) {
      stderr = String((error as { stderr?: Buffer }).stderr);
    }

    expect(stderr).toContain("src/main.ts:2 missing-requirement-anchor");
  }, 20_000);

  // @verifies requirements.enforcement.old_blob The test verifies that deleted type members are classified against the old source snapshot.
  // @verifies requirements.enforcement.type_member_export The test verifies that deleted exported type members are treated as public contract changes.
  it("rejects an unanchored staged deleted exported type member", () => {
    const cwd = createFixtureRepo();
    writeFileSync(join(cwd, "src/main.ts"), "export interface DemoContract {\n  value: string;\n}\n");
    runTool(cwd, ["fmt-agents"]);
    runGit(cwd, ["add", "."]);
    runGit(cwd, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "seed"]);

    writeFileSync(join(cwd, "src/main.ts"), "export interface DemoContract {\n}\n");
    runGit(cwd, ["add", "src/main.ts"]);

    let stderr = "";
    try {
      runTool(cwd, ["check", "--staged"]);
    } catch (error) {
      stderr = String((error as { stderr?: Buffer }).stderr);
    }

    expect(stderr).toContain("src/main.ts:2 missing-requirement-anchor");
  }, 20_000);

  // @verifies requirements.enforcement.base The test verifies that base comparison mode rejects unanchored branch diffs.
  it("rejects an unanchored base diff side effect change", () => {
    const cwd = createFixtureRepo();
    writeFileSync(join(cwd, "src/main.ts"), "export function saveValue(): void {\n}\n");
    runTool(cwd, ["fmt-agents"]);
    runGit(cwd, ["add", "."]);
    runGit(cwd, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "seed"]);

    writeFileSync(join(cwd, "src/main.ts"), "export function saveValue(): void {\n  localStorage.setItem(\"demo\", \"value\");\n}\n");

    let stderr = "";
    try {
      runTool(cwd, ["check", "--base", "HEAD"]);
    } catch (error) {
      stderr = String((error as { stderr?: Buffer }).stderr);
    }

    expect(stderr).toContain("src/main.ts:2 missing-requirement-anchor");
  }, 20_000);
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
      "// @behavior demo The module exposes a demo feature with a verified contract.",
      "import type { DemoType } from \"./types\";",
      "",
      "// @behavior demo.feature The function returns the configured demo value.",
      "export function demoValue(): string {",
      "  return \"demo\";",
      "}",
      "",
      "// @intent demo.contract The interface defines the public demo state contract.",
      "// @constraint demo.contract.shape The interface exposes a demo state contract with verified members.",
      "export interface DemoState {",
      "  // @constraint demo.contract.value The value member exposes the configured demo value.",
      "  value: string;",
      "  // @constraint demo.contract.status The status member exposes readiness states across multiple lines.",
      "  status: {",
      "    kind: \"ready\" | \"pending\";",
      "  };",
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(cwd, "tests/main.test.ts"),
    [
      "import { describe, expect, it } from \"vitest\";",
      "import { demoValue } from \"../src/main\";",
      "",
      "describe(\"demo feature\", () => {",
      "  // @verifies demo.feature The test verifies that the demo feature returns its configured value.",
      "  // @verifies demo.contract.shape The test verifies that the public demo state contract has a verified value member.",
      "  // @verifies demo.contract.value The test verifies that the public demo state keeps its configured value shape.",
      "  // @verifies demo.contract.status The test verifies that the public demo state exposes readiness status shape.",
      "  it(\"returns the configured value\", () => {",
      "    expect(demoValue()).toBe(\"demo\");",
      "  });",
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
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}
