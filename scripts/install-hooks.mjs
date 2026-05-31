import { execFileSync, spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hooksDir = resolve(root, ".githooks");
const preCommitHook = resolve(hooksDir, "pre-commit");

if (!isInsideGitWorkTree(root)) {
  process.exit(0);
}

await mkdir(hooksDir, { recursive: true });
await access(preCommitHook, constants.F_OK);
await chmod(preCommitHook, 0o755);
execFileSync("git", ["config", "core.hooksPath", ".githooks"], { cwd: root, stdio: "inherit" });

function isInsideGitWorkTree(cwd) {
  const result = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd,
    encoding: "utf8"
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status === 0) {
    const isWorkTree = result.stdout.trim();
    if (isWorkTree === "true") {
      return true;
    }
    throw new Error(`git rev-parse reported an unsupported work tree state: ${isWorkTree}`);
  }

  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  if (result.status === 128 && stderr.includes("not a git repository")) {
    return false;
  }

  throw new Error(`git rev-parse failed with status ${result.status}: ${stderr || stdout}`);
}
