// @behavior requirements Requirement comments define a source-local requirement tree, direct verification references, and a synchronized AGENTS.md retrieval index.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import ts from "typescript";

type RequirementTag = "@behavior" | "@constraint" | "@intent" | "@verifies";
// @intent requirements.analysis_consistency Requirement checking uses one consistent analysis fact set for validation, diagnostics, and diff checks.
type SnapshotMode = "worktree" | "staged";
type Command = "scan" | "fmt-agents" | "check" | "help";

// @intent requirements.analysis_consistency.source_text Source analysis pairs each TypeScript path with the exact text selected for validation.
interface SourceFile {
  path: string;
  text: string;
}

// @intent requirements.analysis_consistency.comment_facts Parsed comments retain declaration text or verification references with source location and bound code units.
interface RequirementComment {
  tag: RequirementTag;
  id: string;
  sentence: string;
  file: string;
  line: number;
  start: number;
  end: number;
  target?: BoundTarget;
}

// @intent requirements.analysis_consistency.target_spans Bound targets identify the concrete syntax span justified by one requirement comment.
interface BoundTarget {
  // @constraint requirements.analysis_consistency.target_kind_names Target kind values stay aligned with TypeScript syntax names used in scan output and anchor checks.
  kind: string;
  start: number;
  end: number;
  line: number;
  endLine: number;
  isFile: boolean;
}

// @intent requirements.analysis_consistency.diagnostic_shape Requirement failures share one compiler-style diagnostic shape.
interface Diagnostic {
  file: string;
  line: number;
  rule: string;
  message: string;
}

// @intent requirements.analysis_consistency.cross_file_scope One scan groups declarations, verifications, and diagnostics for cross-file validation.
interface Registry {
  comments: RequirementComment[];
  declarations: Map<string, RequirementComment>;
  verifications: RequirementComment[];
  diagnostics: Diagnostic[];
}

// @intent requirements.analysis_consistency.diff_lines Changed diff lines retain path, old path, location, text, and deletion state for anchor enforcement.
interface HunkLine {
  path: string;
  // @constraint requirements.analysis_consistency.diff_lines.old_path Deleted-file checks retain the old path for source snapshot lookup.
  oldPath: string;
  newLine: number;
  // @constraint requirements.analysis_consistency.diff_lines.current_line Deleted-line checks retain adjacent current-source locations for current anchor lookup.
  currentLine: number;
  text: string;
  // @constraint requirements.analysis_consistency.diff_lines.deleted Removed lines stay distinguishable so deletion-only changes enter anchor checks.
  deleted: boolean;
}

const TAGS = ["@behavior", "@constraint", "@intent", "@verifies"] as const;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const GENERATED_DIRS = new Set([".git", "node_modules", "dist", "coverage", "playwright-report", "test-results"]);
const INDEX_START = "<!-- BEGIN AGENTS_MD_REQUIREMENT_INDEX -->";
const INDEX_END = "<!-- END AGENTS_MD_REQUIREMENT_INDEX -->";
const ID_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

// @behavior requirements.cli Requirement commands provide deterministic local and automation-facing diagnostics with stable exit status.
function main(): void {
  const args = process.argv.slice(2);
  const command = parseCommand(args);
  if (command === "help") {
    printHelp();
    return;
  }

  const staged = args.includes("--staged");
  const base = parseOptionValue(args, "--base");
  // @behavior requirements.cli.snapshot_mode The staged flag selects the source snapshot mode used by command execution.
  const mode: SnapshotMode = staged ? "staged" : "worktree";
  // @behavior requirements.cli.snapshot_load The selected snapshot mode controls which source files enter registry construction.
  const files = loadSnapshot(mode);
  const registry = buildRegistry(files);

  if (command === "scan") {
    printScan(registry);
    printDiagnostics(registry.diagnostics);
    process.exitCode = registry.diagnostics.length > 0 ? 1 : 0;
    return;
  }

  if (command === "fmt-agents") {
    const generated = buildAgentsMd(registry);
    writeFileSync("AGENTS.md", generated);
    return;
  }

  const diagnostics = [...registry.diagnostics];
  // @behavior requirements.cli.index_check Check commands include AGENTS index freshness diagnostics for the selected snapshot mode.
  diagnostics.push(...checkAgentsIndex(registry, mode));
  // @behavior requirements.cli.base_check A base ref adds base-diff anchor diagnostics to the current check.
  if (base) {
    diagnostics.push(...checkBaseDiffAnchors(files, registry, base));
  } else {
    // @behavior requirements.cli.staged_check Staged mode adds staged-diff anchor diagnostics to the current check.
    if (mode === "staged") {
      diagnostics.push(...checkStagedDiffAnchors(files, registry));
    }
  }
  printDiagnostics(diagnostics);
  process.exitCode = diagnostics.length > 0 ? 1 : 0;
}

// @behavior requirements.cli.dispatch Unknown requirement commands resolve to public help output.
function parseCommand(args: string[]): Command {
  const command = args.find((arg) => !arg.startsWith("--")) ?? "help";
  if (command === "scan" || command === "fmt-agents" || command === "check") return command;
  return "help";
}

// @behavior requirements.cli.compare_ref_option Staged and base comparison flags consume the following argument as their comparison ref.
function parseOptionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

// @behavior requirements.cli.help Help output lists the public commands and comparison options used by scripts and hooks.
function printHelp(): void {
  // @behavior requirements.cli.help.usage Help output prints the public usage line on stdout.
  console.log("Usage: tsx tools/requirements/src/main.ts <scan|fmt-agents|check> [--staged] [--base <git-ref>]");
}

// @behavior requirements.source_snapshot Requirement validation reads the selected source snapshot from worktree files or Git index blobs.
function loadSnapshot(mode: SnapshotMode): SourceFile[] {
  // @behavior requirements.source_snapshot.staged_dispatch Staged mode reads the Git index snapshot.
  if (mode === "staged") return loadStagedSnapshot();
  return listWorktreeFiles().map((path) => ({ path, text: readFileSync(path, "utf8") }));
}

// @behavior requirements.source_snapshot.worktree Worktree validation includes editable TypeScript sources under the repository root.
function listWorktreeFiles(root = "."): string[] {
  const result: string[] = [];
  const entries = readdirSync(root);
  for (const entry of entries) {
    const path = root === "." ? entry : join(root, entry);
    const normalized = normalizePath(path);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      if (GENERATED_DIRS.has(entry)) continue;
      result.push(...listWorktreeFiles(path));
      continue;
    }
    if (stats.isFile() && isSourcePath(normalized)) result.push(normalized);
  }
  return result.sort();
}

// @behavior requirements.source_snapshot.staged Staged validation reads Git index blobs so partially staged files use their staged content.
function loadStagedSnapshot(): SourceFile[] {
  const paths = git(["ls-files", "-z"]).split("\0").filter(Boolean).filter(isSourcePath);
  const files: SourceFile[] = [];
  for (const path of paths) {
    // @behavior requirements.source_snapshot.staged.missing_blobs Missing staged blobs are skipped during index snapshot loading.
    try {
      const text = git(["show", `:${path}`]);
      files.push({ path, text });
    } catch {
      continue;
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

// @constraint requirements.source_snapshot.source_scope Generated output, vendored dependencies, declaration files, and skill files stay outside requirement validation.
function isSourcePath(path: string): boolean {
  const normalized = normalizePath(path);
  const parts = normalized.split("/");
  if (parts.some((part) => GENERATED_DIRS.has(part))) return false;
  if (normalized.startsWith(".skills/")) return false;
  if (normalized.endsWith(".d.ts")) return false;
  return [...SOURCE_EXTENSIONS].some((extension) => normalized.endsWith(extension));
}

// @behavior requirements.comment_tree Requirement comments form a validated tree of unique declarations and direct verification references.
// @behavior requirements.comment_tree.repository_scope One command invocation treats declarations and verification references as one repository requirement tree.
function buildRegistry(files: SourceFile[]): Registry {
  const diagnostics: Diagnostic[] = [];
  const comments: RequirementComment[] = [];
  for (const file of files) {
    comments.push(...parseRequirements(file, diagnostics));
  }
  bindRequirements(files, comments, diagnostics);

  const declarations = new Map<string, RequirementComment>();
  const verifications: RequirementComment[] = [];
  for (const comment of comments) {
    if (comment.tag === "@verifies") {
      verifications.push(comment);
      continue;
    }
    const existing = declarations.get(comment.id);
    if (existing) {
      diagnostics.push(diag(comment, "duplicate-requirement-id", `requirement id ${comment.id} is already declared at ${existing.file}:${existing.line}`));
      continue;
    }
    // @constraint requirements.comment_tree.unique_ids The first declaration for an ID becomes the repository declaration entry.
    declarations.set(comment.id, comment);
  }

  validateDeclarations(comments, declarations, verifications, diagnostics);
  return { comments, declarations, verifications, diagnostics };
}

// @constraint requirements.comment_syntax Source comments become declarations with tag, unique dotted ID, and one sentence or verification references with tag and ID.
function parseRequirements(file: SourceFile, diagnostics: Diagnostic[]): RequirementComment[] {
  const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true);
  const ranges = collectCommentRanges(file.text, source);
  const comments: RequirementComment[] = [];

  for (const range of ranges) {
    const body = normalizeCommentText(file.text.slice(range.pos, range.end));
    const matches = [...body.matchAll(/@(behavior|constraint|intent|verifies)\s+/g)];
    if (matches.length === 0) continue;
    const line = offsetLine(file.text, range.pos);
    if (matches.length > 1) {
      diagnostics.push({ file: file.path, line, rule: "multiple-requirement-tags", message: "requirement comments must contain exactly one tag" });
      continue;
    }
    const parsed = body.match(/^@(behavior|constraint|intent|verifies)\s+([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*)(?:\s+(.+))?$/s);
    if (!parsed) {
      diagnostics.push({ file: file.path, line, rule: "invalid-requirement-comment", message: "requirement comments must use a tag and dotted id" });
      continue;
    }
    const tag = `@${parsed[1]}` as RequirementTag;
    const id = parsed[2]!;
    const sentence = parsed[3]?.trim() ?? "";
    const comment: RequirementComment = { tag, id, sentence, file: file.path, line, start: range.pos, end: range.end };
    if (!ID_PATTERN.test(id)) diagnostics.push(diag(comment, "invalid-requirement-id", "requirement id must use dotted lowercase segments"));
    if (tag === "@verifies") {
      if (sentence) diagnostics.push(diag(comment, "invalid-verification-reference", "verification comments must contain only a tag and referenced id"));
    } else if (!isOneSentence(sentence)) {
      diagnostics.push(diag(comment, "invalid-comment-body", "requirement declarations must contain one sentence"));
    }
    comments.push(comment);
  }

  return comments;
}

// @behavior requirements.comment_syntax.discovery Line comments and block comments are discoverable through TypeScript trivia ranges.
function collectCommentRanges(text: string, source: ts.SourceFile): ts.CommentRange[] {
  const ranges: ts.CommentRange[] = [];
  const seen = new Set<string>();
  const addRanges = (position: number) => {
    for (const range of ts.getLeadingCommentRanges(text, position) ?? []) {
      const key = `${range.pos}:${range.end}`;
      // @behavior requirements.comment_syntax.discovery.dedupe Duplicate trivia ranges collapse to one discovered comment.
      if (!seen.has(key)) {
        seen.add(key);
        ranges.push(range);
      }
    }
  };
  addRanges(0);
  const visit = (node: ts.Node) => {
    addRanges(node.pos);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return ranges.sort((a, b) => a.pos - b.pos);
}

// @behavior requirements.comment_syntax.normalization Comment markers are removed before requirement text is validated.
function normalizeCommentText(raw: string): string {
  if (raw.startsWith("//")) return raw.replace(/^\/\/\s?/, "").trim();
  return raw
    .replace(/^\/\*\*?/, "")
    .replace(/\*\/$/, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\*\s?/, "").trim())
    .join(" ")
    .trim();
}

// @constraint requirements.comment_syntax.declaration_sentence Requirement declaration sentences use one terminal sentence mark and one sentence boundary.
function isOneSentence(sentence: string): boolean {
  if (!/[.!?]$/.test(sentence)) return false;
  const withoutFinal = sentence.slice(0, -1);
  return !/[.!?]\s+\S/.test(withoutFinal);
}

// @constraint requirements.comment_binding Every requirement declaration attaches to exactly one file, declaration, statement, expression, or test node.
function bindRequirements(files: SourceFile[], comments: RequirementComment[], diagnostics: Diagnostic[]): void {
  const byFile = new Map<string, RequirementComment[]>();
  for (const comment of comments) {
    const bucket = byFile.get(comment.file) ?? [];
    bucket.push(comment);
    // @behavior requirements.comment_binding.file_buckets Requirement comments are bucketed by source path before syntax binding.
    byFile.set(comment.file, bucket);
  }

  for (const file of files) {
    const fileComments = byFile.get(file.path) ?? [];
    if (fileComments.length === 0) continue;
    const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true);
    const nodes = collectBindableNodes(source);
    const firstCodeStart = findFirstCodeStart(source);
    for (const comment of fileComments) {
      const beforeComment = file.text.slice(0, comment.start);
      const beforeFirstCode = file.text.slice(comment.end, firstCodeStart);
      // @behavior requirements.comment_binding.first_declaration A first requirement comment directly above the first declaration binds that declaration.
      if (comment.end <= firstCodeStart && onlyWhitespaceAndComments(beforeComment) && hasImportStatement(beforeFirstCode)) {
        comment.target = { kind: "file", start: 0, end: file.text.length, line: 1, endLine: offsetLine(file.text, file.text.length), isFile: true };
        continue;
      }
      const target = nodes.find((node) => comment.end <= node.start && onlyWhitespaceAndComments(file.text.slice(comment.end, node.start)));
      if (!target) {
        diagnostics.push(diag(comment, "unbound-requirement-comment", "requirement comment must bind to the next syntax node"));
        continue;
      }
      comment.target = target;
    }
  }
}

// @constraint requirements.comment_binding.target_nodes Declarations and behavior-owning statements are eligible requirement targets.
function collectBindableNodes(source: ts.SourceFile): BoundTarget[] {
  const nodes: BoundTarget[] = [];
  // @constraint requirements.comment_binding.target_nodes.target_facts Bound targets record syntax kind, span, and one-based line range.
  const add = (node: ts.Node, kind: string) => {
    nodes.push({
      kind,
      start: node.getStart(source),
      end: node.getEnd(),
      line: offsetLine(source.text, node.getStart(source)),
      endLine: offsetLine(source.text, node.getEnd()),
      isFile: false,
    });
  };
  // @behavior requirements.comment_binding.target_nodes.walk The TypeScript syntax walk collects every bindable node in source order.
  const visit = (node: ts.Node) => {
    if (isBindableNode(node)) add(node, ts.SyntaxKind[node.kind]);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return nodes.sort((a, b) => a.start - b.start || a.end - b.end);
}

// @constraint requirements.comment_binding.target_kinds Requirement targets include declarations, branches, side effects, returns, throws, and test calls.
function isBindableNode(node: ts.Node): boolean {
  if (ts.isImportDeclaration(node)) return false;
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isExportDeclaration(node) ||
    ts.isPropertySignature(node) ||
    ts.isMethodSignature(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isVariableStatement(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isExpressionStatement(node) ||
    ts.isIfStatement(node) ||
    ts.isSwitchStatement(node) ||
    ts.isCaseClause(node) ||
    ts.isDefaultClause(node) ||
    ts.isForStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isTryStatement(node) ||
    ts.isReturnStatement(node) ||
    ts.isThrowStatement(node) ||
    ts.isAwaitExpression(node) ||
    ts.isCallExpression(node) ||
    ts.isNewExpression(node)
  ) {
    return true;
  }
  return false;
}

// @behavior requirements.comment_binding.file_level The first file-level requirement comment can bind before the first non-import syntax unit.
function findFirstCodeStart(source: ts.SourceFile): number {
  let first = source.text.length;
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement)) continue;
    first = Math.min(first, statement.getStart(source));
  }
  return first;
}

function hasImportStatement(text: string): boolean {
  return /^\s*import\b/m.test(text);
}

// @constraint requirements.comment_binding.adjacency Only whitespace and ordinary comments may separate a requirement comment from its target node.
function onlyWhitespaceAndComments(text: string): boolean {
  const stripped = text
    .replace(/\/\/[^\n\r]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .trim();
  return stripped.length === 0;
}

// @behavior requirements.comment_tree.validation Requirement checks enforce declared ancestry, valid verification references, test locations, and leaf coverage.
function validateDeclarations(
  comments: RequirementComment[],
  declarations: Map<string, RequirementComment>,
  verifications: RequirementComment[],
  diagnostics: Diagnostic[],
): void {
  for (const comment of comments) {
    if (comment.tag === "@verifies") continue;
    for (const ancestor of ancestors(comment.id)) {
      if (!declarations.has(ancestor)) diagnostics.push(diag(comment, "missing-requirement-ancestor", `requirement id ${comment.id} requires ancestor ${ancestor}`));
    }
  }

  const verifiedIds = new Set<string>();
  for (const verification of verifications) {
    const target = declarations.get(verification.id);
    if (!target) {
      diagnostics.push(diag(verification, "missing-verification-target", `verification references missing requirement ${verification.id}`));
      continue;
    }
    if (target.tag === "@intent") diagnostics.push(diag(verification, "invalid-verification-target", "verification must reference a behavior or constraint"));
    if (!isTestPath(verification.file)) diagnostics.push(diag(verification, "verification-outside-test", "verification comments must appear in configured test paths"));
    // @constraint requirements.comment_tree.validation.verified_id_set Verification coverage is tracked by referenced requirement ID.
    verifiedIds.add(verification.id);
  }

  for (const [id, declaration] of declarations) {
    if (declaration.tag === "@intent") continue;
    if (!isLeaf(id, declarations)) continue;
    if (!verifiedIds.has(id)) diagnostics.push(diag(declaration, "unverified-leaf-requirement", `leaf requirement ${id} needs at least one @verifies reference`));
  }
}

// @constraint requirements.comment_tree.validation.declared_ancestors Every dotted requirement ID has declared parent IDs up to its root.
function ancestors(id: string): string[] {
  const parts = id.split(".");
  const result: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    result.push(parts.slice(0, index).join("."));
  }
  return result;
}

// @constraint requirements.comment_tree.validation.leaf_coverage Leaf behavior and constraint IDs require verification coverage.
function isLeaf(id: string, declarations: Map<string, RequirementComment>): boolean {
  const prefix = `${id}.`;
  for (const other of declarations.keys()) {
    if (other.startsWith(prefix)) return false;
  }
  return true;
}

// @constraint requirements.comment_tree.validation.test_references Verification references stay inside unit, integration, or e2e test files.
function isTestPath(path: string): boolean {
  return path.startsWith("tests/") || /\.test\.[cm]?tsx?$/.test(path) || /\.spec\.[cm]?tsx?$/.test(path);
}

// @behavior requirements.agent_index Requirement declaration changes produce a matching generated AGENTS.md index block.
function buildAgentsMd(registry: Registry): string {
  const current = existsSync("AGENTS.md") ? readFileSync("AGENTS.md", "utf8") : defaultAgentsMd();
  const block = buildIndexBlock(registry);
  if (current.includes(INDEX_START) && current.includes(INDEX_END)) {
    const start = current.indexOf(INDEX_START);
    const end = current.indexOf(INDEX_END) + INDEX_END.length;
    return `${current.slice(0, start)}${block}${current.slice(end)}`;
  }
  // @behavior requirements.agent_index.default_insertion Missing AGENTS markers receive the baseline requirement instructions before the generated index.
  const insertion = `\n## Requirement Comments\n\nRequirement truth lives in source comments. Use \`@behavior\`, \`@constraint\`, and \`@intent\` for globally unique requirement declarations with one sentence bound to one code unit. A code unit can be a module, type, function, method, branch, state transition, external call, failure path, assertion, or narrower syntax unit. Organize dotted IDs by product or tool requirement domain, then by narrower behavioral detail; a descendant ID expresses a detail of its ancestor next to the code unit that implements that detail. A broad file, type, or function comment covers that code unit only, so inner branches, state transitions, side effects, failure policies, structural abstractions, and test assertions need narrower descendant comments. Public contracts, state policies, durable writes, external calls, observability effects, timeouts, retries, error mapping, access or safety rules, structural abstractions, and test expectations require local requirement comments when they are added or changed. Architecture descriptions, module boundaries, layer duties, helper names, parser roles, loader roles, generator roles, wrapper roles, record shapes, command names, and code-navigation notes belong in ordinary engineering docs or ordinary comments. \`@intent\` is reserved for an active abstraction boundary whose current business purpose is required by the system. Use \`@verifies\` as a direct reference whose content is exactly the tag plus an existing \`@behavior\` or \`@constraint\` ID, choosing the most specific ID that the test expectation verifies. Search source comments for an ID before changing behavior or structure. The generated requirement index is for retrieval and is updated with \`npm run req:fmt-agents\` after requirement tag changes.\n\n${block}\n`;
  return current.endsWith("\n") ? `${current}${insertion}` : `${current}\n${insertion}`;
}

// @behavior requirements.agent_index.default_body Repositories without an agent guide receive baseline requirement instructions before index generation.
function defaultAgentsMd(): string {
  return "# Engineering Notes\n";
}

// @constraint requirements.agent_index.deterministic_rows Generated index rows are deterministic for declared behavior, constraint, and intent IDs.
function buildIndexBlock(registry: Registry): string {
  const ids = [...registry.declarations.keys()].sort();
  const children = new Map<string, string[]>();
  for (const id of ids) {
    // @behavior requirements.agent_index.deterministic_rows.child_buckets Every declaration ID receives a deterministic child bucket before row rendering.
    children.set(id, []);
  }
  for (const id of ids) {
    const parent = parentId(id);
    if (!parent) continue;
    const siblings = children.get(parent);
    if (siblings) siblings.push(id);
  }
  const rows = ids.map((id) => {
    const childIds = (children.get(id) ?? []).sort().map((child) => child.slice(id.length + 1));
    return childIds.length === 0 ? `|${id}|${id}.{}` : `|${id}|${id}.{${childIds.join(",")}}`;
  });
  return [
    INDEX_START,
    "[Requirement Index]|root:.",
    "|IMPORTANT: Requirement truth lives in source comments; search source comments for an ID before changing code.",
    "|source:source_comments_only",
    "|declaration_body:single_sentence",
    "|verification_body:tag_plus_existing_id",
    "|binding:one_requirement_comment_per_code_unit",
    "|inner_details:descendant_ids_near_inner_code_units",
    "|tags:{@behavior,@constraint,@intent,@verifies}",
    ...rows,
    INDEX_END,
  ].join("\n");
}

// @constraint requirements.agent_index.parent_rows Immediate parent IDs come from removing the last dotted segment.
function parentId(id: string): string | undefined {
  const index = id.lastIndexOf(".");
  if (index === -1) return undefined;
  return id.slice(0, index);
}

// @behavior requirements.agent_index.freshness Requirement checks fail when AGENTS.md differs from the index generated for the selected snapshot.
function checkAgentsIndex(registry: Registry, mode: SnapshotMode): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  let text = "";
  // @behavior requirements.agent_index.freshness.snapshot_read The selected snapshot mode controls where AGENTS.md text is read from.
  try {
    text = mode === "staged" ? git(["show", ":AGENTS.md"]) : readFileSync("AGENTS.md", "utf8");
  } catch {
    diagnostics.push({ file: "AGENTS.md", line: 1, rule: "missing-agents-md", message: "AGENTS.md must contain the generated requirement index" });
    return diagnostics;
  }
  const generated = buildAgentsMd(registry);
  const currentBlock = extractIndexBlock(text);
  const generatedBlock = extractIndexBlock(generated);
  if (!currentBlock || currentBlock !== generatedBlock) {
    diagnostics.push({ file: "AGENTS.md", line: 1, rule: "stale-requirement-index", message: "run npm run req:fmt-agents and stage AGENTS.md" });
  }
  return diagnostics;
}

// @constraint requirements.agent_index.marker_bounds Generated index content stays bounded by stable AGENTS.md markers.
function extractIndexBlock(text: string): string | undefined {
  const start = text.indexOf(INDEX_START);
  const end = text.indexOf(INDEX_END);
  if (start === -1 || end === -1 || end < start) return undefined;
  return text.slice(start, end + INDEX_END.length);
}

// @behavior requirements.change_anchoring Changed contracts, states, effects, failures, safety rules, structures, and tests require local requirement anchors.
function checkStagedDiffAnchors(files: SourceFile[], registry: Registry): Diagnostic[] {
  return checkDiffAnchors(files, registry, parseGitDiff(["diff", "--cached", "--unified=0", "--", "*.ts", "*.tsx", "*.mts", "*.cts"]), "HEAD");
}

// @behavior requirements.change_anchoring.base_diff Pull-request changes receive forced-anchor diagnostics against the configured base ref.
function checkBaseDiffAnchors(files: SourceFile[], registry: Registry, base: string): Diagnostic[] {
  return checkDiffAnchors(files, registry, parseGitDiff(["diff", "--unified=0", base, "--", "*.ts", "*.tsx", "*.mts", "*.cts"]), base);
}

// @behavior requirements.change_anchoring.required_tags Diff lines in forced-anchor categories fail without a matching local requirement tag.
function checkDiffAnchors(files: SourceFile[], registry: Registry, lines: HunkLine[], oldRef: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const commentsByFile = groupComments(registry.comments);
  for (const line of lines) {
    const file = line.deleted ? loadOldSourceFile(oldRef, line.oldPath) ?? filesByPath.get(line.path) : filesByPath.get(line.path) ?? loadOldSourceFile(oldRef, line.oldPath);
    if (!file) continue;
    // @constraint requirements.change_anchoring.comment_line_skip Only standalone requirement comment lines skip forced-anchor classification.
    if (/^\s*(?:\/\/|\/\*)\s*@(behavior|constraint|intent|verifies)\s+/.test(line.text)) continue;
    const categories = classifyChangedLine(line.text, line.path, file, line.newLine);
    if (categories.length === 0) continue;
    const anchorSources = line.deleted ? deletedLineAnchorSources(file, line.newLine, filesByPath.get(line.path), commentsByFile.get(line.path), line.currentLine) : [{ file, comments: commentsByFile.get(line.path) ?? [], line: line.newLine }];
    for (const category of categories) {
      if (anchorSources.some((source) => hasAnchorForLine(source.comments, source.line, category, source.file, line.text))) continue;
      diagnostics.push({
        file: line.path,
        line: line.newLine,
        rule: missingAnchorRule(category),
        message: `${category} change requires a local requirement anchor`,
      });
    }
  }
  return diagnostics;
}

// @behavior requirements.change_anchoring.current_deletion_anchor Deleted-line checks accept current-source anchors that document the surviving owner.
function deletedLineAnchorSources(
  oldFile: SourceFile,
  oldLine: number,
  currentFile: SourceFile | undefined,
  currentComments: RequirementComment[] | undefined,
  currentLine: number,
): Array<{ file: SourceFile; comments: RequirementComment[]; line: number }> {
  const sources = [{ file: oldFile, comments: bindRequirementCommentsForFile(oldFile), line: oldLine }];
  if (currentFile && currentComments) sources.push({ file: currentFile, comments: currentComments, line: currentLine });
  return sources;
}

// @behavior requirements.change_anchoring.deleted_context Deleted TypeScript lines keep old-snapshot syntax context during staged and base checks.
function loadOldSourceFile(ref: string, path: string): SourceFile | undefined {
  // @behavior requirements.change_anchoring.deleted_context.missing_old_blob Missing old source blobs drop deletion-context anchor checks for that path.
  try {
    return { path, text: git(["show", `${ref}:${path}`]) };
  } catch {
    return undefined;
  }
}

// @behavior requirements.change_anchoring.previous_deletion_anchor Deleted lines can still use anchors that existed in the old source snapshot.
function bindRequirementCommentsForFile(file: SourceFile): RequirementComment[] {
  const diagnostics: Diagnostic[] = [];
  const comments = parseRequirements(file, diagnostics);
  bindRequirements([file], comments, diagnostics);
  return comments;
}

// @behavior requirements.change_anchoring.diff_lines Added and deleted diff lines retain adjacent source line numbers for diagnostics.
function parseGitDiff(args: string[]): HunkLine[] {
  const diff = git(args);
  const lines: HunkLine[] = [];
  let path = "";
  let oldPath = "";
  let newLine = 0;
  let oldLine = 0;
  for (const raw of diff.split(/\r?\n/)) {
    const oldFileMatch = raw.match(/^--- a\/(.+)$/);
    if (oldFileMatch) {
      oldPath = oldFileMatch[1]!;
      if (!path) path = oldPath;
      continue;
    }
    const fileMatch = raw.match(/^\+\+\+ b\/(.+)$/);
    if (fileMatch) {
      path = fileMatch[1]!;
      continue;
    }
    if (raw === "+++ /dev/null") {
      path = oldPath;
      continue;
    }
    const hunkMatch = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      oldLine = Number(hunkMatch[1]!);
      newLine = Number(hunkMatch[2]!);
      continue;
    }
    if (!path || raw.startsWith("+++") || raw.startsWith("---")) continue;
    if (raw.startsWith("+")) {
      lines.push({ path, oldPath, newLine, currentLine: newLine, text: raw.slice(1), deleted: false });
      newLine += 1;
      continue;
    }
    if (raw.startsWith("-")) {
      lines.push({ path, oldPath, newLine: Math.max(1, oldLine), currentLine: Math.max(1, newLine), text: raw.slice(1), deleted: true });
      oldLine += 1;
      continue;
    }
    oldLine += 1;
    newLine += 1;
  }
  return lines;
}

// @behavior requirements.change_anchoring.changed_categories TypeScript diff lines receive forced-anchor categories from their text and syntax context.
function classifyChangedLine(text: string, path: string, file: SourceFile, line: number): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("import ")) return [];
  const standaloneLiteral = trimmed.startsWith("\"") || trimmed.startsWith("'") || trimmed.startsWith("`");
  if (isTestPath(path)) {
    if (standaloneLiteral) return [];
    return /\b(expect|assert|mock|fixture|snapshot|toEqual|toBe|toThrow)\b/.test(trimmed) ? ["test-expectation"] : [];
  }
  const typeMember = isTrackedTypeMemberLine(file, line, trimmed);
  const plainProperty = /^[A-Za-z_$][\w$?]*:\s/.test(trimmed) && !typeMember;
  const categories = new Set<string>();
  // @behavior requirements.change_anchoring.changed_categories.contract Exported lines and tracked type members require contract anchors.
  if (/^(export|public)\b/.test(trimmed) || typeMember) categories.add("contract");
  // @behavior requirements.change_anchoring.changed_categories.state State-shaped text and transition markers require state-policy anchors.
  if (/\b(state|status|phase|mode|step|kind|lifecycle|ready|pending|hidden|error)\b|\bswitch\b|\bcase\b|transition|setState|mark[A-Z]|complete|fail|cancel|retry/.test(trimmed)) categories.add("state-policy");
  // @behavior requirements.change_anchoring.changed_categories.effect External calls, storage writes, messaging, tracing, and emitted events require side-effect anchors.
  if (/fetch\(|chrome\.|indexedDB|localStorage|sessionStorage|\.put\(|\.add\(|\.delete\(|\.set\(|sendMessage|connect\(|postMessage|console\.|trace|emit|dispatchEvent|createObjectStore/.test(trimmed)) categories.add("side-effect");
  // @behavior requirements.change_anchoring.changed_categories.failure Failure keywords and timeout or retry mechanisms require failure-policy anchors.
  if (/\btry\b|\bcatch\b|\bfinally\b|\bthrow\b|Error\b|timeout|retry|fallback|AbortController|Promise\.race|setTimeout/.test(trimmed)) categories.add("failure-policy");
  // @behavior requirements.change_anchoring.changed_categories.safety Access, credential, URL, editing, translation, escaping, redaction, and privacy text require access-safety anchors.
  if (/sanitize|secret|apiKey|token|credential|password|permission|origin|URL|url|editable|notranslate|translate=|escape|redact|privacy/.test(trimmed)) categories.add("access-safety");
  // @behavior requirements.change_anchoring.changed_categories.structure Structural abstraction declarations require structure-intent anchors.
  if (/\binterface\b|\babstract\s+class\b|\bclass\s+\w*(Adapter|Registry|Factory|Provider|Resolver|Middleware|Plugin|Bridge|Wrapper)\b/.test(trimmed)) categories.add("structure-intent");
  if ((standaloneLiteral || plainProperty) && categories.size === 0) return [];
  return [...categories];
}

// @behavior requirements.change_anchoring.type_member_changes Exported type members, implicit-public class members, and state-shaped members remain visible to contract and state-policy checks.
function isTrackedTypeMemberLine(file: SourceFile, line: number, text: string): boolean {
  const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true);
  let matched = false;
  const visit = (node: ts.Node) => {
    if (matched) return;
    if (ts.isPropertySignature(node) || ts.isMethodSignature(node) || ts.isPropertyDeclaration(node) || ts.isMethodDeclaration(node)) {
      const startLine = offsetLine(file.text, node.getStart(source));
      const endLine = offsetLine(file.text, node.getEnd());
      // @behavior requirements.change_anchoring.type_member_changes.span_match A changed line inside a type member uses the member visibility and state-shaped text for classification.
      if (startLine <= line && line <= endLine) {
        matched = isExportedTypeMember(node) || isImplicitPublicClassMember(node) || /\b(state|status|phase|mode|step|kind|lifecycle|ready|pending|hidden|error)\b/.test(text);
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return matched;
}

// @behavior requirements.change_anchoring.exported_type_members Members of exported interfaces and exported type literals count as public contracts.
function isExportedTypeMember(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isInterfaceDeclaration(current) || ts.isTypeAliasDeclaration(current)) return hasExportModifier(current);
    current = current.parent;
  }
  return false;
}

// @constraint requirements.change_anchoring.export_modifier Type-member owners use TypeScript export, private, and protected modifiers to indicate public contract membership.
function isImplicitPublicClassMember(node: ts.Node): boolean {
  if (!ts.isPropertyDeclaration(node) && !ts.isMethodDeclaration(node)) return false;
  if (!ts.isClassDeclaration(node.parent) || !hasExportModifier(node.parent)) return false;
  // @constraint requirements.change_anchoring.export_modifier.implicit_public Exported class members count as public unless TypeScript marks them private or protected.
  return !ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword || modifier.kind === ts.SyntaxKind.ProtectedKeyword);
}

// @constraint requirements.change_anchoring.export_modifier.export_keyword TypeScript export modifiers mark type owners as public contract containers.
function hasExportModifier(node: ts.HasModifiers): boolean {
  // @constraint requirements.change_anchoring.export_modifier.export_keyword.scan Modifier scanning detects TypeScript export keywords on target owners.
  return !!ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

// @behavior requirements.change_anchoring.file_local_lookup Parsed comments are grouped by source path before local anchor lookup.
function groupComments(comments: RequirementComment[]): Map<string, RequirementComment[]> {
  const result = new Map<string, RequirementComment[]>();
  for (const comment of comments) {
    const bucket = result.get(comment.file) ?? [];
    bucket.push(comment);
    // @behavior requirements.change_anchoring.file_local_lookup.bucket Requirement comments are grouped under their declaring file path.
    result.set(comment.file, bucket);
  }
  return result;
}

// @constraint requirements.change_anchoring.local_anchor A valid local anchor has a non-file target that locally covers the changed line and whose tag matches the forced category.
function hasAnchorForLine(comments: RequirementComment[], line: number, category: string, file: SourceFile, text: string): boolean {
  const typeMember = isTrackedTypeMemberLine(file, line, text);
  return comments.some((comment) => {
    if (!comment.target || comment.target.isFile) return false;
    // @constraint requirements.change_anchoring.local_anchor.type_member_target Type-member changes require a matching member-level anchor for contract and state-policy categories.
    if (typeMember && (category === "contract" || category === "state-policy") && !["PropertySignature", "MethodSignature", "PropertyDeclaration", "MethodDeclaration"].includes(comment.target.kind)) return false;
    if (!targetLocallyCoversLine(comment.target, line, category, typeMember)) return false;
    if (category === "structure-intent") return comment.tag === "@intent";
    if (category === "test-expectation") return comment.tag === "@verifies";
    return comment.tag === "@behavior" || comment.tag === "@constraint";
  });
}

// @constraint requirements.change_anchoring.local_anchor.inner_scope Broad declaration comments only anchor their declaration line for inner behavior categories.
function targetLocallyCoversLine(target: BoundTarget, line: number, category: string, typeMember: boolean): boolean {
  // @constraint requirements.change_anchoring.local_anchor.inner_scope.type_member_span Type-member anchors can cover the member span for contract and state-policy changes.
  if (typeMember && (category === "contract" || category === "state-policy")) {
    return target.line <= line && line <= target.endLine;
  }
  // @constraint requirements.change_anchoring.local_anchor.inner_scope.broad_declaration_line Broad declaration anchors match only their starting line for forced inner behavior categories.
  if (requiresExactAnchorLine(target.kind, category)) {
    return line === target.line;
  }
  return target.line <= line && line <= target.endLine;
}

// @constraint requirements.change_anchoring.local_anchor.inner_scope.exact_target_kinds Function, method, class, interface, and type alias anchors use exact-line matching for inner categories.
function requiresExactAnchorLine(kind: string, category: string): boolean {
  // @constraint requirements.change_anchoring.local_anchor.inner_scope.structure_test_span Structure-intent and test-expectation anchors keep span matching for their bound syntax unit.
  if (category === "structure-intent" || category === "test-expectation") return false;
  // @constraint requirements.change_anchoring.local_anchor.inner_scope.exact_target_kinds.declaration_list Exact-line matching applies to broad declaration target kinds.
  return ["FunctionDeclaration", "MethodDeclaration", "ClassDeclaration", "InterfaceDeclaration", "TypeAliasDeclaration"].includes(kind);
}

// @constraint requirements.change_anchoring.rule_names Forced-anchor diagnostics use stable searchable rule names.
function missingAnchorRule(category: string): string {
  if (category === "structure-intent") return "missing-structure-intent";
  if (category === "test-expectation") return "missing-verification-anchor";
  return "missing-requirement-anchor";
}

// @behavior requirements.diagnostic_output Requirement commands print scan data and compiler-style diagnostics for local debugging and automation logs.
const OUTPUT_ENCODING = "utf8";

// @behavior requirements.diagnostic_output.scan_listing Scan output lists discovered declarations, verification references, and binding targets.
function printScan(registry: Registry): void {
  // @behavior requirements.diagnostic_output.scan_listing.rows Each scan row prints file, line, tag, ID, and bound target.
  for (const comment of registry.comments) {
    const target = comment.target ? `${comment.target.kind}@${comment.target.line}` : "unbound";
    console.log(`${comment.file}:${comment.line} ${comment.tag} ${comment.id} -> ${target}`);
  }
}

// @behavior requirements.diagnostic_output.compiler_style Diagnostic output uses compiler-style messages and stays silent when validation passes.
function printDiagnostics(diagnostics: Diagnostic[]): void {
  // @behavior requirements.diagnostic_output.compiler_style.stderr Diagnostics print to stderr as file-line rule messages.
  for (const diagnostic of diagnostics) {
    console.error(`${diagnostic.file}:${diagnostic.line} ${diagnostic.rule} ${diagnostic.message}`);
  }
}

// @behavior requirements.source_snapshot.git_reads Git-backed snapshot and diff reads return stdout text to requirement checks.
function git(args: string[]): string {
  return execFileSync("git", args, { encoding: OUTPUT_ENCODING });
}

// @constraint requirements.diagnostic_output.portable_paths Diagnostics use stable forward-slash paths across platforms.
function normalizePath(path: string): string {
  return relative(".", path).split(sep).join("/");
}

// @constraint requirements.diagnostic_output.line_numbers Source locations use one-based line numbers derived from character offsets.
function offsetLine(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

// @behavior requirements.diagnostic_output.comment_locations Requirement comment failures report their source file and line.
function diag(comment: RequirementComment, rule: string, message: string): Diagnostic {
  return { file: comment.file, line: comment.line, rule, message };
}

main();
