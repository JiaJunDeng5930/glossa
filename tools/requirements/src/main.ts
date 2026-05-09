// @behavior requirements The tool validates source-comment requirements and updates the AGENTS.md retrieval index.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import ts from "typescript";

type RequirementTag = "@behavior" | "@constraint" | "@intent" | "@verifies";
// @intent requirements.types The internal type declarations define source snapshots, comments, bindings, diagnostics, registries, and staged diff lines.
type SnapshotMode = "worktree" | "staged";
type Command = "scan" | "fmt-agents" | "check" | "help";

// @intent requirements.types.source_file The source-file interface carries one TypeScript path and its snapshot text.
interface SourceFile {
  path: string;
  text: string;
}

// @intent requirements.types.comment The requirement-comment interface records parsed tag data and its bound syntax target.
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

// @intent requirements.types.target The bound-target interface records the syntax span that owns a requirement comment.
interface BoundTarget {
  // @constraint requirements.types.target.kind The kind member stores the TypeScript syntax kind used in scan output and anchor checks.
  kind: string;
  start: number;
  end: number;
  line: number;
  endLine: number;
  isFile: boolean;
}

// @intent requirements.types.diagnostic The diagnostic interface defines compiler-style requirement validation output.
interface Diagnostic {
  file: string;
  line: number;
  rule: string;
  message: string;
}

// @intent requirements.types.registry The registry interface groups declarations, verifications, and diagnostics for one scan.
interface Registry {
  comments: RequirementComment[];
  declarations: Map<string, RequirementComment>;
  verifications: RequirementComment[];
  diagnostics: Diagnostic[];
}

// @intent requirements.types.hunk_line The hunk-line interface records changed staged or base diff lines with source locations.
interface HunkLine {
  path: string;
  // @constraint requirements.types.hunk_line.old_path The oldPath member preserves deleted-file context for old blob lookup.
  oldPath: string;
  newLine: number;
  text: string;
  // @constraint requirements.types.hunk_line.deleted The deleted member marks removal hunks so deletion-only changes enter anchor checks.
  deleted: boolean;
}

const TAGS = ["@behavior", "@constraint", "@intent", "@verifies"] as const;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const GENERATED_DIRS = new Set([".git", "node_modules", "dist", "coverage", "playwright-report", "test-results"]);
const INDEX_START = "<!-- BEGIN AGENTS_MD_REQUIREMENT_INDEX -->";
const INDEX_END = "<!-- END AGENTS_MD_REQUIREMENT_INDEX -->";
const ID_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

// @behavior requirements.cli The entrypoint dispatches the requested requirement command and exits with compiler-style diagnostics.
function main(): void {
  const args = process.argv.slice(2);
  const command = parseCommand(args);
  if (command === "help") {
    printHelp();
    return;
  }

  const staged = args.includes("--staged");
  const base = parseOptionValue(args, "--base");
  const mode: SnapshotMode = staged ? "staged" : "worktree";
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
  diagnostics.push(...checkAgentsIndex(registry, mode));
  if (base) {
    diagnostics.push(...checkBaseDiffAnchors(files, registry, base));
  } else if (mode === "staged") {
    diagnostics.push(...checkStagedDiffAnchors(files, registry));
  }
  printDiagnostics(diagnostics);
  process.exitCode = diagnostics.length > 0 ? 1 : 0;
}

// @behavior requirements.cli.command The parser maps npm script arguments to one stable tool operation.
function parseCommand(args: string[]): Command {
  const command = args.find((arg) => !arg.startsWith("--")) ?? "help";
  if (command === "scan" || command === "fmt-agents" || command === "check") return command;
  return "help";
}

// @behavior requirements.cli.option The option parser reads flag values used by staged and base comparison modes.
function parseOptionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

// @behavior requirements.cli.help The help output lists the public commands used by npm scripts and hooks.
function printHelp(): void {
  console.log("Usage: tsx tools/requirements/src/main.ts <scan|fmt-agents|check> [--staged] [--base <git-ref>]");
}

// @behavior requirements.snapshot The loader returns TypeScript source text from the requested repository snapshot.
function loadSnapshot(mode: SnapshotMode): SourceFile[] {
  if (mode === "staged") return loadStagedSnapshot();
  return listWorktreeFiles().map((path) => ({ path, text: readFileSync(path, "utf8") }));
}

// @behavior requirements.snapshot.worktree The worktree scanner includes editable TypeScript sources and excludes generated directories.
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

// @behavior requirements.snapshot.staged The staged scanner reads Git index blobs so partially staged files are validated from their committed snapshot.
function loadStagedSnapshot(): SourceFile[] {
  const paths = git(["ls-files", "-z"]).split("\0").filter(Boolean).filter(isSourcePath);
  const files: SourceFile[] = [];
  for (const path of paths) {
    try {
      const text = git(["show", `:${path}`]);
      files.push({ path, text });
    } catch {
      continue;
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

// @constraint requirements.snapshot.sources The source filter keeps generated output and vendored dependencies outside the requirement registry.
function isSourcePath(path: string): boolean {
  const normalized = normalizePath(path);
  const parts = normalized.split("/");
  if (parts.some((part) => GENERATED_DIRS.has(part))) return false;
  if (normalized.startsWith(".skills/")) return false;
  if (normalized.endsWith(".d.ts")) return false;
  return [...SOURCE_EXTENSIONS].some((extension) => normalized.endsWith(extension));
}

// @behavior requirements.registry The registry builder parses comments, binds them to syntax nodes, and validates cross-file properties.
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
    declarations.set(comment.id, comment);
  }

  validateDeclarations(comments, declarations, verifications, diagnostics);
  return { comments, declarations, verifications, diagnostics };
}

// @behavior requirements.parse The parser extracts exactly one requirement tag, dotted ID, and sentence from each matching comment.
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
    const parsed = body.match(/^@(behavior|constraint|intent|verifies)\s+([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*)\s+(.+)$/s);
    if (!parsed) {
      diagnostics.push({ file: file.path, line, rule: "invalid-requirement-comment", message: "requirement comments must use a tag, dotted id, and one sentence" });
      continue;
    }
    const tag = `@${parsed[1]}` as RequirementTag;
    const id = parsed[2]!;
    const sentence = parsed[3]!.trim();
    const comment: RequirementComment = { tag, id, sentence, file: file.path, line, start: range.pos, end: range.end };
    if (!ID_PATTERN.test(id)) diagnostics.push(diag(comment, "invalid-requirement-id", "requirement id must use dotted lowercase segments"));
    if (!isOneSentence(sentence)) diagnostics.push(diag(comment, "invalid-comment-body", "requirement comments must contain one sentence"));
    comments.push(comment);
  }

  return comments;
}

// @behavior requirements.parse.comments The comment collector uses TypeScript trivia ranges so line and block comments share one parser path.
function collectCommentRanges(text: string, source: ts.SourceFile): ts.CommentRange[] {
  const ranges: ts.CommentRange[] = [];
  const seen = new Set<string>();
  const addRanges = (position: number) => {
    for (const range of ts.getLeadingCommentRanges(text, position) ?? []) {
      const key = `${range.pos}:${range.end}`;
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

// @behavior requirements.parse.normalize The normalizer removes TypeScript comment markers before tag parsing.
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

// @constraint requirements.parse.sentence The sentence validator accepts one terminal sentence mark and rejects multiple sentence boundaries.
function isOneSentence(sentence: string): boolean {
  if (!/[.!?]$/.test(sentence)) return false;
  const withoutFinal = sentence.slice(0, -1);
  return !/[.!?]\s+\S/.test(withoutFinal);
}

// @behavior requirements.binding The binder attaches each requirement comment to one file, declaration, statement, expression, or test node.
function bindRequirements(files: SourceFile[], comments: RequirementComment[], diagnostics: Diagnostic[]): void {
  const byFile = new Map<string, RequirementComment[]>();
  for (const comment of comments) {
    const bucket = byFile.get(comment.file) ?? [];
    bucket.push(comment);
    byFile.set(comment.file, bucket);
  }

  for (const file of files) {
    const fileComments = byFile.get(file.path) ?? [];
    if (fileComments.length === 0) continue;
    const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true);
    const nodes = collectBindableNodes(source);
    const firstCodeStart = findFirstCodeStart(source);
    const firstStatement = source.statements[0];
    const firstStatementIsImport = !!firstStatement && (ts.isImportDeclaration(firstStatement) || ts.isImportEqualsDeclaration(firstStatement));
    for (const comment of fileComments) {
      if (firstStatementIsImport && comment.end <= firstCodeStart && onlyWhitespaceAndComments(file.text.slice(0, comment.start))) {
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

// @behavior requirements.binding.nodes The node collector records declarations and executable statements that can own a requirement.
function collectBindableNodes(source: ts.SourceFile): BoundTarget[] {
  const nodes: BoundTarget[] = [];
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
  const visit = (node: ts.Node) => {
    if (isBindableNode(node)) add(node, ts.SyntaxKind[node.kind]);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return nodes.sort((a, b) => a.start - b.start || a.end - b.end);
}

// @constraint requirements.binding.kinds The bindable-kind set includes TypeScript declarations, branches, side effects, returns, throws, and test calls.
function isBindableNode(node: ts.Node): boolean {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return false;
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
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

// @behavior requirements.binding.first_code The first-code detector finds the first non-import syntax unit for file-level requirement binding.
function findFirstCodeStart(source: ts.SourceFile): number {
  let first = source.text.length;
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement)) continue;
    first = Math.min(first, statement.getStart(source));
  }
  return first;
}

// @constraint requirements.binding.trivia The trivia checker accepts whitespace and ordinary comments between a requirement comment and its target node.
function onlyWhitespaceAndComments(text: string): boolean {
  const stripped = text
    .replace(/\/\/[^\n\r]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .trim();
  return stripped.length === 0;
}

// @behavior requirements.validate The validator enforces ID ancestry, verification references, test locations, and leaf verification coverage.
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
    verifiedIds.add(verification.id);
  }

  for (const [id, declaration] of declarations) {
    if (declaration.tag === "@intent") continue;
    if (!isLeaf(id, declarations)) continue;
    if (!verifiedIds.has(id)) diagnostics.push(diag(declaration, "unverified-leaf-requirement", `leaf requirement ${id} needs at least one @verifies reference`));
  }
}

// @behavior requirements.validate.ancestors The ancestor helper expands dotted IDs into required parent declarations.
function ancestors(id: string): string[] {
  const parts = id.split(".");
  const result: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    result.push(parts.slice(0, index).join("."));
  }
  return result;
}

// @behavior requirements.validate.leaf The leaf detector treats declarations with no narrower declared child as concrete verification targets.
function isLeaf(id: string, declarations: Map<string, RequirementComment>): boolean {
  const prefix = `${id}.`;
  for (const other of declarations.keys()) {
    if (other.startsWith(prefix)) return false;
  }
  return true;
}

// @constraint requirements.validate.tests The test-path policy keeps verification comments inside unit, integration, or e2e test files.
function isTestPath(path: string): boolean {
  return path.startsWith("tests/") || /\.test\.[cm]?tsx?$/.test(path) || /\.spec\.[cm]?tsx?$/.test(path);
}

// @behavior requirements.agents The AGENTS.md generator replaces only the generated requirement index block.
function buildAgentsMd(registry: Registry): string {
  const current = existsSync("AGENTS.md") ? readFileSync("AGENTS.md", "utf8") : defaultAgentsMd();
  const block = buildIndexBlock(registry);
  if (current.includes(INDEX_START) && current.includes(INDEX_END)) {
    const start = current.indexOf(INDEX_START);
    const end = current.indexOf(INDEX_END) + INDEX_END.length;
    return `${current.slice(0, start)}${block}${current.slice(end)}`;
  }
  const insertion = `\n## Requirement Comments\n\nRequirement truth lives in one-sentence source comments. Use only \`@behavior\`, \`@constraint\`, \`@intent\`, and \`@verifies\`; dotted IDs form an arbitrary-depth tree; details belong in narrower descendant IDs near the code units that implement them. Search source comments for an ID before changing behavior or structure. The generated requirement index is for retrieval and is updated with \`npm run req:fmt-agents\` after requirement tag changes.\n\n${block}\n`;
  return current.endsWith("\n") ? `${current}${insertion}` : `${current}\n${insertion}`;
}

// @behavior requirements.agents.default The default AGENTS.md body bootstraps requirement instructions when a repository has no agent guide.
function defaultAgentsMd(): string {
  return "# Engineering Notes\n";
}

// @behavior requirements.agents.index The index builder emits deterministic rows for declared behavior, constraint, and intent IDs.
function buildIndexBlock(registry: Registry): string {
  const ids = [...registry.declarations.keys()].sort();
  const children = new Map<string, string[]>();
  for (const id of ids) {
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
    "|comment_body:single_sentence",
    "|tags:{@behavior,@constraint,@intent,@verifies}",
    ...rows,
    INDEX_END,
  ].join("\n");
}

// @behavior requirements.agents.parent The parent helper returns the immediate dotted ancestor for an ID.
function parentId(id: string): string | undefined {
  const index = id.lastIndexOf(".");
  if (index === -1) return undefined;
  return id.slice(0, index);
}

// @behavior requirements.agents.check The index checker compares AGENTS.md against the generated index for the selected snapshot.
function checkAgentsIndex(registry: Registry, mode: SnapshotMode): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  let text = "";
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

// @behavior requirements.agents.extract The index extractor returns the generated block bounded by stable markers.
function extractIndexBlock(text: string): string | undefined {
  const start = text.indexOf(INDEX_START);
  const end = text.indexOf(INDEX_END);
  if (start === -1 || end === -1 || end < start) return undefined;
  return text.slice(start, end + INDEX_END.length);
}

// @behavior requirements.diff The staged diff checker requires local requirement anchors for changed contracts, states, effects, failures, safety rules, structures, and tests.
function checkStagedDiffAnchors(files: SourceFile[], registry: Registry): Diagnostic[] {
  return checkDiffAnchors(files, registry, parseGitDiff(["diff", "--cached", "--unified=0", "--", "*.ts", "*.tsx", "*.mts", "*.cts"]), "HEAD");
}

// @behavior requirements.diff.base The base diff checker applies forced-anchor diagnostics to pull-request changes in CI.
function checkBaseDiffAnchors(files: SourceFile[], registry: Registry, base: string): Diagnostic[] {
  return checkDiffAnchors(files, registry, parseGitDiff(["diff", "--unified=0", base, "--", "*.ts", "*.tsx", "*.mts", "*.cts"]), base);
}

// @behavior requirements.diff.check The diff checker requires local requirement anchors for changed contracts, states, effects, failures, safety rules, structures, and tests.
function checkDiffAnchors(files: SourceFile[], registry: Registry, lines: HunkLine[], oldRef: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const commentsByFile = groupComments(registry.comments);
  for (const line of lines) {
    const file = filesByPath.get(line.path) ?? loadOldSourceFile(oldRef, line.oldPath);
    if (!file) continue;
    if (/@(behavior|constraint|intent|verifies)\s+/.test(line.text)) continue;
    const categories = classifyChangedLine(line.text, line.path, file, line.newLine);
    if (categories.length === 0) continue;
    const comments = commentsByFile.get(line.path) ?? [];
    for (const category of categories) {
      if (hasAnchorForLine(comments, line.newLine, category, file, line.text)) continue;
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

// @behavior requirements.diff.old_blob The old-blob loader provides syntax context for staged or base diffs that delete a TypeScript file.
function loadOldSourceFile(ref: string, path: string): SourceFile | undefined {
  try {
    return { path, text: git(["show", `${ref}:${path}`]) };
  } catch {
    return undefined;
  }
}

// @behavior requirements.diff.parse The diff parser extracts added and deleted staged lines with adjacent source line numbers.
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
      lines.push({ path, oldPath, newLine, text: raw.slice(1), deleted: false });
      newLine += 1;
      continue;
    }
    if (raw.startsWith("-")) {
      lines.push({ path, oldPath, newLine: Math.max(1, oldLine), text: raw.slice(1), deleted: true });
      oldLine += 1;
      continue;
    }
    oldLine += 1;
    newLine += 1;
  }
  return lines;
}

// @behavior requirements.diff.classify The classifier maps TypeScript diff lines and syntax context to the forced-anchor categories from the skill.
function classifyChangedLine(text: string, path: string, file: SourceFile, line: number): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("import ")) return [];
  if (trimmed.startsWith("\"") || trimmed.startsWith("'") || trimmed.startsWith("`")) return [];
  if (isTestPath(path)) {
    return /\b(expect|assert|mock|fixture|snapshot|toEqual|toBe|toThrow)\b/.test(trimmed) ? ["test-expectation"] : [];
  }
  const typeMember = isTrackedTypeMemberLine(file, line, trimmed);
  if (/^[A-Za-z_$][\w$?]*:\s/.test(trimmed) && !typeMember) return [];
  const categories = new Set<string>();
  if (/^(export|public)\b/.test(trimmed) || typeMember) categories.add("contract");
  if (/\b(state|status|phase|mode|step|kind|lifecycle|ready|pending|hidden|error)\b|\bswitch\b|\bcase\b|transition|setState|mark[A-Z]|complete|fail|cancel|retry/.test(trimmed)) categories.add("state-policy");
  if (/fetch\(|chrome\.|indexedDB|localStorage|sessionStorage|\.put\(|\.add\(|\.delete\(|\.set\(|sendMessage|connect\(|postMessage|console\.|trace|emit|dispatchEvent|createObjectStore/.test(trimmed)) categories.add("side-effect");
  if (/\btry\b|\bcatch\b|\bfinally\b|\bthrow\b|Error\b|timeout|retry|fallback|AbortController|Promise\.race|setTimeout/.test(trimmed)) categories.add("failure-policy");
  if (/sanitize|secret|apiKey|token|credential|password|permission|origin|URL|url|editable|notranslate|translate=|escape|redact|privacy/.test(trimmed)) categories.add("access-safety");
  if (/\binterface\b|\babstract\s+class\b|\bclass\s+\w*(Adapter|Registry|Factory|Provider|Resolver|Middleware|Plugin|Bridge|Wrapper)\b/.test(trimmed)) categories.add("structure-intent");
  return [...categories];
}

// @behavior requirements.diff.type_member The syntax classifier keeps exported and state-shaped type members visible to contract and state-policy checks.
function isTrackedTypeMemberLine(file: SourceFile, line: number, text: string): boolean {
  const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true);
  let matched = false;
  const visit = (node: ts.Node) => {
    if (matched) return;
    if (ts.isPropertySignature(node) || ts.isMethodSignature(node)) {
      const startLine = offsetLine(file.text, node.getStart(source));
      const endLine = offsetLine(file.text, node.getEnd());
      if (startLine <= line && line <= endLine) {
        matched = isExportedTypeMember(node) || /\b(state|status|phase|mode|step|kind|lifecycle|ready|pending|hidden|error)\b/.test(text);
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return matched;
}

// @behavior requirements.diff.type_member_export The export detector treats members of exported interfaces and exported type literals as public contracts.
function isExportedTypeMember(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isInterfaceDeclaration(current) || ts.isTypeAliasDeclaration(current)) return hasExportModifier(current);
    current = current.parent;
  }
  return false;
}

// @behavior requirements.diff.type_member_export_modifier The modifier detector reads TypeScript export keywords from declarations that own type members.
function hasExportModifier(node: ts.Node): boolean {
  return !!ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

// @behavior requirements.diff.group The grouping helper indexes parsed comments by source path for anchor lookup.
function groupComments(comments: RequirementComment[]): Map<string, RequirementComment[]> {
  const result = new Map<string, RequirementComment[]>();
  for (const comment of comments) {
    const bucket = result.get(comment.file) ?? [];
    bucket.push(comment);
    result.set(comment.file, bucket);
  }
  return result;
}

// @constraint requirements.diff.anchor The anchor lookup accepts a non-file target whose local span covers the changed line and whose tag matches the forced category.
function hasAnchorForLine(comments: RequirementComment[], line: number, category: string, file: SourceFile, text: string): boolean {
  const typeMember = isTrackedTypeMemberLine(file, line, text);
  return comments.some((comment) => {
    if (!comment.target || comment.target.isFile) return false;
    if (typeMember && (category === "contract" || category === "state-policy") && !["PropertySignature", "MethodSignature"].includes(comment.target.kind)) return false;
    const startLine = comment.line;
    const endLine = comment.target.endLine;
    if (line < startLine || line > endLine) return false;
    if (category === "structure-intent") return comment.tag === "@intent";
    if (category === "test-expectation") return comment.tag === "@verifies";
    return comment.tag === "@behavior" || comment.tag === "@constraint";
  });
}

// @behavior requirements.diff.rule The rule-name mapper keeps forced-anchor diagnostics stable and searchable.
function missingAnchorRule(category: string): string {
  if (category === "structure-intent") return "missing-structure-intent";
  if (category === "test-expectation") return "missing-verification-anchor";
  return "missing-requirement-anchor";
}

// @behavior requirements.output The output helpers emit scan data and diagnostics for local debugging and automation logs.
const OUTPUT_ENCODING = "utf8";

// @behavior requirements.output.scan The scan printer lists discovered declarations and verification links for local debugging.
function printScan(registry: Registry): void {
  for (const comment of registry.comments) {
    const target = comment.target ? `${comment.target.kind}@${comment.target.line}` : "unbound";
    console.log(`${comment.file}:${comment.line} ${comment.tag} ${comment.id} -> ${target}`);
  }
}

// @behavior requirements.output.diagnostics The diagnostic printer emits compiler-style messages and stays silent when validation passes.
function printDiagnostics(diagnostics: Diagnostic[]): void {
  for (const diagnostic of diagnostics) {
    console.error(`${diagnostic.file}:${diagnostic.line} ${diagnostic.rule} ${diagnostic.message}`);
  }
}

// @behavior requirements.git The Git wrapper returns stdout for repository snapshot and diff commands.
function git(args: string[]): string {
  return execFileSync("git", args, { encoding: OUTPUT_ENCODING });
}

// @behavior requirements.path The path normalizer gives diagnostics stable forward-slash paths across platforms.
function normalizePath(path: string): string {
  return relative(".", path).split(sep).join("/");
}

// @behavior requirements.location The line mapper converts character offsets into one-based source lines.
function offsetLine(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

// @behavior requirements.diagnostic The diagnostic helper maps a requirement comment to a source location.
function diag(comment: RequirementComment, rule: string, message: string): Diagnostic {
  return { file: comment.file, line: comment.line, rule, message };
}

main();
