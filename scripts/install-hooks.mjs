import { chmod, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

try {
  execFileSync("git", ["rev-parse", "--git-dir"], { stdio: "ignore" });
  await mkdir(".githooks", { recursive: true });
  await chmod(resolve(".githooks/pre-commit"), 0o755);
  execFileSync("git", ["config", "core.hooksPath", ".githooks"], { stdio: "ignore" });
} catch {
}
