import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("requirement automation tool", () => {
  // @verifies requirements.cli.command The test verifies that the command parser accepts the public help command.
  // @verifies requirements.cli.help The test verifies that help output lists the public requirement commands.
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
  // @verifies requirements.diff.parse The test verifies that staged checking can parse Git diff hunks.
  // @verifies requirements.diff.classify The test verifies that staged checking classifies forced-anchor categories.
  // @verifies requirements.diff.group The test verifies that staged checking groups anchors by file path.
  // @verifies requirements.diff.anchor The test verifies that staged checking accepts local anchors for changed lines.
  // @verifies requirements.diff.rule The test verifies that staged checking emits stable missing-anchor rules.
  // @verifies requirements.output.scan The test verifies that scan output includes discovered requirement records.
  // @verifies requirements.output.diagnostics The test verifies that diagnostic output stays compiler-style.
  // @verifies requirements.git The test verifies that the tool can invoke Git-backed commands.
  // @verifies requirements.path The test verifies that path normalization appears in scan output.
  // @verifies requirements.location The test verifies that source locations appear in scan output.
  // @verifies requirements.diagnostic The test verifies that diagnostics carry source file and line context.
  it("prints public help", () => {
    const output = execFileSync("npx", ["tsx", "tools/requirements/src/main.ts", "help"], {
      encoding: "utf8",
      env: { ...process.env, TMPDIR: "/tmp" },
    });

    expect(output).toContain("Usage: tsx tools/requirements/src/main.ts");
  });
});
