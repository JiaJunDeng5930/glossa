import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const TOOL = resolve("tools/requirements/src/main.ts");
const TSX = resolve("node_modules/tsx/dist/cli.mjs");

describe("requirement automation tool", () => {
  // @verifies requirements.cli.dispatch
  // @verifies requirements.cli.help
  // @verifies requirements.cli.help.usage
  // @verifies requirements.cli.compare_ref_option
  // @verifies requirements.cli.full_anchor_check
  // @verifies requirements.test_config
  // @verifies requirements.test_config.browser
  it("prints public help", () => {
    const output = runTool(process.cwd(), ["help"]);

    expect(output).toContain("Usage: tsx tools/requirements/src/main.ts");
    expect(output).toContain("[--all]");
  }, 120_000);

  // @verifies requirements.source_snapshot.worktree
  // @verifies requirements.source_snapshot.staged
  // @verifies requirements.source_snapshot.source_scope
  // @verifies requirements.comment_tree.repository_scope
  // @verifies requirements.comment_syntax.discovery
  // @verifies requirements.comment_syntax.normalization
  // @verifies requirements.comment_syntax.declaration_sentence
  // @verifies requirements.comment_binding.target_nodes
  // @verifies requirements.comment_binding.target_kinds
  // @verifies requirements.analysis_consistency.target_kind_names
  // @verifies requirements.comment_binding.file_level
  // @verifies requirements.comment_binding.adjacency
  // @verifies requirements.comment_tree.validation.declared_ancestors
  // @verifies requirements.comment_tree.validation.leaf_coverage
  // @verifies requirements.comment_tree.validation.test_references
  // @verifies requirements.agent_index.default_body
  // @verifies requirements.agent_index.deterministic_rows
  // @verifies requirements.agent_index.parent_rows
  // @verifies requirements.agent_index.freshness
  // @verifies requirements.agent_index.marker_bounds
  // @verifies requirements.change_anchoring.required_tags
  // @verifies requirements.change_anchoring.local_anchor
  // @verifies requirements.diagnostic_output.scan_listing
  // @verifies requirements.source_snapshot.git_reads
  // @verifies requirements.diagnostic_output.portable_paths
  // @verifies requirements.diagnostic_output.line_numbers
  // @verifies requirements.diagnostic_output.comment_locations
  // @verifies requirements.cli.snapshot_mode
  // @verifies requirements.cli.snapshot_load
  // @verifies requirements.cli.index_check
  // @verifies requirements.cli.staged_check
  // @verifies requirements.source_snapshot.staged_dispatch
  // @verifies requirements.comment_tree.unique_ids
  // @verifies requirements.comment_syntax.discovery.dedupe
  // @verifies requirements.comment_binding.file_buckets
  // @verifies requirements.comment_binding.target_nodes.target_facts
  // @verifies requirements.comment_binding.target_nodes.walk
  // @verifies requirements.comment_tree.validation.verified_id_set
  // @verifies requirements.agent_index.default_insertion
  // @verifies requirements.agent_index.deterministic_rows.child_buckets
  // @verifies requirements.agent_index.freshness.snapshot_read
  // @verifies requirements.diagnostic_output.scan_listing.rows
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
  }, 120_000);

  // @verifies requirements.change_anchoring.diff_lines
  // @verifies requirements.change_anchoring.changed_categories
  // @verifies requirements.change_anchoring.type_member_changes
  // @verifies requirements.change_anchoring.exported_type_members
  // @verifies requirements.change_anchoring.export_modifier
  // @verifies requirements.change_anchoring.export_modifier.export_keyword
  // @verifies requirements.change_anchoring.local_anchor.inner_scope.type_member_span
  // @verifies requirements.change_anchoring.file_local_lookup
  // @verifies requirements.change_anchoring.file_local_lookup.bucket
  // @verifies requirements.change_anchoring.rule_names
  // @verifies requirements.diagnostic_output.compiler_style
  // @verifies requirements.diagnostic_output.compiler_style.stderr
  // @verifies requirements.change_anchoring.changed_categories.contract
  // @verifies requirements.change_anchoring.changed_categories.state
  // @verifies requirements.change_anchoring.type_member_changes.span_match
  // @verifies requirements.change_anchoring.export_modifier.implicit_public
  // @verifies requirements.change_anchoring.export_modifier.export_keyword.scan
  // @verifies requirements.change_anchoring.local_anchor.type_member_target
  it("rejects an unanchored staged type-member state change", () => {
    const cwd = createFixtureRepo();
    writeValidRequirementFiles(cwd);
    runTool(cwd, ["fmt-agents"]);
    runGit(cwd, ["add", "."]);
    runGit(cwd, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "seed"]);

    writeFileSync(
      join(cwd, "src/main.ts"),
      [
        "// @behavior demo The demo command has verified behavior.",
        "// @behavior demo.feature The demo command returns the configured value.",
        "export function demoValue(): string {",
        "  return \"demo\";",
        "}",
        "",
        "// @intent demo.contract The demo state contract exposes verified fields.",
        "// @constraint demo.contract.shape The demo state contract exposes its verified member shape.",
        "export interface DemoState {",
        "  // @constraint demo.contract.value The demo value member exposes the configured value.",
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
  }, 120_000);

  // @verifies requirements.change_anchoring.type_member_changes
  it("rejects an unanchored implicit-public class member change", () => {
    const cwd = createFixtureRepo();
    writeFileSync(
      join(cwd, "src/main.ts"),
      [
        "export class DemoApi {",
        "  value = \"old\";",
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
        "export class DemoApi {",
        "  value = \"new\";",
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
  }, 120_000);

  // @verifies requirements.comment_binding.target_kinds
  // @verifies requirements.change_anchoring.local_anchor
  it("accepts an anchored staged re-export contract change", () => {
    const cwd = createFixtureRepo();
    writeFileSync(join(cwd, "src/foo.ts"), "export const foo = 1;\n");
    writeFileSync(join(cwd, "src/main.ts"), "");
    runTool(cwd, ["fmt-agents"]);
    runGit(cwd, ["add", "."]);
    runGit(cwd, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "seed"]);

    writeFileSync(
      join(cwd, "src/main.ts"),
      [
        "// @behavior demo The demo exports have verified behavior.",
        "// @behavior demo.reexport The demo exports foo from its source module.",
        "export { foo } from \"./foo\";",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(cwd, "tests/main.test.ts"),
      [
        "import { expect, it } from \"vitest\";",
        "",
        "// @verifies demo.reexport",
        "it(\"re-exports foo\", () => {",
        "  expect(true).toBe(true);",
        "});",
        "",
      ].join("\n"),
    );
    runTool(cwd, ["fmt-agents"]);
    runGit(cwd, ["add", "."]);

    runTool(cwd, ["check", "--staged"]);
  }, 120_000);

  // @verifies requirements.comment_binding.first_declaration
  // @verifies requirements.change_anchoring.local_anchor
  it("accepts an anchored first declaration in a new staged file", () => {
    const cwd = createFixtureRepo();
    writeFileSync(join(cwd, "src/main.ts"), "");
    runTool(cwd, ["fmt-agents"]);
    runGit(cwd, ["add", "."]);
    runGit(cwd, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "seed"]);

    writeFileSync(
      join(cwd, "src/main.ts"),
      [
        "// @behavior demo The demo command has verified behavior.",
        "export function runDemo(): string {",
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
        "// @verifies demo",
        "it(\"runs demo\", () => {",
        "  expect(true).toBe(true);",
        "});",
        "",
      ].join("\n"),
    );
    runTool(cwd, ["fmt-agents"]);
    runGit(cwd, ["add", "."]);

    runTool(cwd, ["check", "--staged"]);
  }, 120_000);

  // @verifies requirements.change_anchoring.changed_categories
  // @verifies requirements.change_anchoring.changed_categories.structure
  // @verifies requirements.change_anchoring.changed_categories.failure
  // @verifies requirements.change_anchoring.changed_categories.safety
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
        "export function loadSecret(): void {",
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
        "export const config = {",
        "  status: \"error\",",
        "};",
        "export const states = [",
        "  \"hidden\",",
        "];",
        "export function loadSecret(): void {",
        "  throw new Error(\"apiKey missing\");",
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
    expect(stderr).toContain("src/main.ts:5 missing-requirement-anchor");
    expect(stderr).toContain("src/main.ts:8 missing-requirement-anchor");
  }, 120_000);

  // @verifies requirements.change_anchoring.diff_lines
  // @verifies requirements.change_anchoring.deleted_context
  // @verifies requirements.change_anchoring.deleted_context.missing_old_blob
  // @verifies requirements.change_anchoring.previous_deletion_anchor
  // @verifies requirements.change_anchoring.changed_categories.effect
  // @verifies requirements.analysis_consistency.diff_lines.old_path
  // @verifies requirements.analysis_consistency.diff_lines.deleted
  // @verifies requirements.analysis_consistency.diff_lines.current_line
  it("rejects an unanchored deletion-only side effect change", () => {
    const cwd = createFixtureRepo();
    writeFileSync(
      join(cwd, "src/main.ts"),
      [
        "const STORAGE_KEY = \"demo\";",
        "export function saveValue(): void {",
        "  localStorage.setItem(STORAGE_KEY, \"value\");",
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

    expect(stderr).toContain("src/main.ts:3 missing-requirement-anchor");
  }, 120_000);

  // @verifies requirements.change_anchoring.current_deletion_anchor
  it("accepts a current anchor for a deletion-only side effect change", () => {
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
        "// @behavior demo The demo command has verified behavior.",
        "const STORAGE_KEY = \"demo\";",
        "",
        "// @behavior demo.save The save command leaves browser storage unchanged.",
        "export function saveValue(): void {",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(cwd, "tests/main.test.ts"),
      [
        "import { expect, it } from \"vitest\";",
        "",
        "// @verifies demo.save",
        "it(\"leaves storage untouched\", () => {",
        "  expect(true).toBe(true);",
        "});",
        "",
      ].join("\n"),
    );
    runTool(cwd, ["fmt-agents"]);
    runGit(cwd, ["add", "."]);

    runTool(cwd, ["check", "--staged"]);
    runTool(cwd, ["check", "--base", "HEAD"]);
  }, 120_000);

  // @verifies requirements.change_anchoring.deleted_context
  // @verifies requirements.change_anchoring.exported_type_members
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
  }, 120_000);

  // @verifies requirements.change_anchoring.base_diff
  // @verifies requirements.cli.base_check
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
      "import type { DemoType } from \"./types\";",
      "",
      "// @behavior demo.feature The demo command returns the configured value.",
      "export function demoValue(): string {",
      "  return \"demo\";",
      "}",
      "",
      "// @intent demo.contract The demo state contract exposes verified fields.",
      "// @constraint demo.contract.shape The demo state contract exposes its verified member shape.",
      "export interface DemoState {",
      "  // @constraint demo.contract.value The demo value member exposes the configured value.",
      "  value: string;",
      "  // @constraint demo.contract.status The demo status member exposes readiness states across multiple lines.",
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
      "  // @verifies demo.feature",
      "  // @verifies demo.contract.shape",
      "  // @verifies demo.contract.value",
      "  // @verifies demo.contract.status",
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
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
}
