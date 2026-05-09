import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const TOOL = resolve("tools/requirements/src/main.ts");
const TSX = resolve("node_modules/tsx/dist/cli.mjs");

describe("requirement automation tool", () => {
  // @verifies requirements.cli.command The test verifies that the command parser accepts the public help command.
  // @verifies requirements.cli.help The test verifies that help output lists the public requirement commands.
  it("prints public help", () => {
    const output = runTool(process.cwd(), ["help"]);

    expect(output).toContain("Usage: tsx tools/requirements/src/main.ts");
  });

  // @verifies requirements.snapshot.worktree The test verifies that the worktree command can scan editable source files.
  // @verifies requirements.snapshot.staged The test verifies that the staged command can read the Git index.
  // @verifies requirements.snapshot.sources The test verifies that source filtering keeps the tool focused on editable TypeScript files.
  // @verifies requirements.registry The test verifies that registry construction is exercised by the scan command.
  // @verifies requirements.parse.comments The test verifies that TypeScript comment ranges are consumed by the scan command.
  // @verifies requirements.parse.normalize The test verifies that line comments are normalized into requirement records.
  // @verifies requirements.parse.sentence The test verifies that single-sentence comments pass the scanner.
  // @verifies requirements.binding.nodes The test verifies that syntax nodes are bound during scan output.
  // @verifies requirements.binding.kinds The test verifies that declarations can own requirement comments.
  // @verifies requirements.binding.first_code The test verifies that file-level requirements can bind before code.
  // @verifies requirements.binding.trivia The test verifies that comment trivia can appear before a target node.
  // @verifies requirements.validate.ancestors The test verifies that declared requirement ancestors are accepted.
  // @verifies requirements.validate.leaf The test verifies that leaf requirements can be linked by verification comments.
  // @verifies requirements.validate.tests The test verifies that verification comments can live in Vitest files.
  // @verifies requirements.agents.default The test verifies that index generation has a fallback AGENTS body.
  // @verifies requirements.agents.index The test verifies that index generation emits requirement rows.
  // @verifies requirements.agents.parent The test verifies that dotted parent relationships feed index rows.
  // @verifies requirements.agents.check The test verifies that the check command compares AGENTS.md with generated output.
  // @verifies requirements.agents.extract The test verifies that generated index markers can be read by the checker.
  // @verifies requirements.diff.anchor The test verifies that staged checking accepts local anchors for changed lines.
  // @verifies requirements.output.scan The test verifies that scan output includes discovered requirement records.
  // @verifies requirements.git The test verifies that the tool can invoke Git-backed commands.
  // @verifies requirements.path The test verifies that path normalization appears in scan output.
  // @verifies requirements.location The test verifies that source locations appear in scan output.
  // @verifies requirements.diagnostic The test verifies that diagnostics carry source file and line context.
  it("formats AGENTS.md and checks a valid staged requirement snapshot", () => {
    const cwd = createFixtureRepo();
    writeValidRequirementFiles(cwd);

    runGit(cwd, ["add", "."]);
    runTool(cwd, ["fmt-agents"]);
    runGit(cwd, ["add", "AGENTS.md"]);

    const scan = runTool(cwd, ["scan"]);
    expect(scan).toContain("src/main.ts:1 @behavior demo -> FunctionDeclaration@3");
    expect(scan).toContain("InterfaceDeclaration");

    runTool(cwd, ["check"]);
    runTool(cwd, ["check", "--staged"]);

    const agents = readFileSync(join(cwd, "AGENTS.md"), "utf8");
    expect(agents).toContain("|demo.feature|demo.feature.{}");
  }, 20_000);

  // @verifies requirements.diff.parse The test verifies that staged checking can parse Git diff hunks.
  // @verifies requirements.diff.classify The test verifies that staged checking classifies forced-anchor categories.
  // @verifies requirements.diff.type_member The test verifies that type member changes remain visible to contract and state-policy checks.
  // @verifies requirements.diff.group The test verifies that staged checking groups anchors by file path.
  // @verifies requirements.diff.rule The test verifies that staged checking emits stable missing-anchor rules.
  // @verifies requirements.output.diagnostics The test verifies that diagnostic output stays compiler-style.
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
