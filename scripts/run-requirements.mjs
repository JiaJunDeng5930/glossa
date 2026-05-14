import { spawn } from "node:child_process";
import { resolve } from "node:path";

const command = process.execPath;
const args = [resolve("node_modules/tsx/dist/cli.mjs"), resolve("tools/requirements/src/main.ts"), ...process.argv.slice(2)];
const child = spawn(command, args, {
  env: {
    ...process.env,
    TMPDIR: process.env.TMPDIR || process.env.TEMP || "/tmp",
  },
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`requirements check exited from signal ${signal}`);
    process.exit(1);
  }

  process.exit(code ?? 1);
});
