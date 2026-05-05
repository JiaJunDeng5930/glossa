import { mkdir, copyFile, cp, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
const watch = process.argv.includes("--watch");

await rm(dist, { recursive: true, force: true });
await mkdir(resolve(dist, "options"), { recursive: true });
await mkdir(resolve(dist, "popup"), { recursive: true });
await mkdir(resolve(dist, "assets"), { recursive: true });

const context = await esbuild.context({
  entryPoints: {
    content: resolve(root, "src/content/index.ts"),
    background: resolve(root, "src/background/index.ts"),
    options: resolve(root, "src/options/options.ts"),
    popup: resolve(root, "src/popup/popup.ts")
  },
  bundle: true,
  format: "esm",
  target: "chrome120",
  sourcemap: true,
  outdir: dist,
  logLevel: "info"
});

await copyStaticFiles();

if (watch) {
  await context.watch();
  console.log("Watching Glossa extension sources...");
} else {
  await context.rebuild();
  await context.dispose();
}

async function copyStaticFiles() {
  await copyFile(resolve(root, "manifest.json"), resolve(dist, "manifest.json"));
  await copyFile(resolve(root, "src/options/options.html"), resolve(dist, "options/options.html"));
  await copyFile(resolve(root, "src/popup/popup.html"), resolve(dist, "popup/popup.html"));
  await cp(resolve(root, "assets"), resolve(dist, "assets"), { recursive: true });
}
