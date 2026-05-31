import { watch as watchFs } from "node:fs";
import { mkdir, copyFile, cp, rm } from "node:fs/promises";
import { dirname, normalize, resolve } from "node:path";
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
  const closeStaticWatchers = watchStaticFiles(createStaticCopyScheduler(async (error) => {
    console.error("Static file copy failed during watch.");
    console.error(error);
    closeStaticWatchers();
    await context.dispose();
    process.exit(1);
  }));
  const stopWatch = async () => {
    closeStaticWatchers();
    await context.dispose();
    process.exit(0);
  };
  process.once("SIGINT", () => {
    void stopWatch();
  });
  process.once("SIGTERM", () => {
    void stopWatch();
  });
  console.log("Watching Glossa extension sources and static files...");
} else {
  await context.rebuild();
  await context.dispose();
}

async function copyStaticFiles() {
  await mkdir(dist, { recursive: true });
  await mkdir(resolve(dist, "options"), { recursive: true });
  await mkdir(resolve(dist, "popup"), { recursive: true });
  await copyFile(resolve(root, "manifest.json"), resolve(dist, "manifest.json"));
  await copyFile(resolve(root, "src/options/options.html"), resolve(dist, "options/options.html"));
  await copyFile(resolve(root, "src/popup/popup.html"), resolve(dist, "popup/popup.html"));
  await rm(resolve(dist, "assets"), { recursive: true, force: true });
  await cp(resolve(root, "assets"), resolve(dist, "assets"), { recursive: true });
}

function createStaticCopyScheduler(onFailure) {
  let timer;
  let copyQueue = Promise.resolve();

  return () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      copyQueue = copyQueue
        .then(copyStaticFiles)
        .then(() => {
          console.log("Copied static extension files.");
        });
      void copyQueue.catch(onFailure);
    }, 50);
  };
}

function watchStaticFiles(onChange) {
  const watchers = [
    watchStaticPath(root, false, (filename) => filename === "manifest.json", onChange),
    watchStaticPath(resolve(root, "src/options"), false, (filename) => filename === "options.html", onChange),
    watchStaticPath(resolve(root, "src/popup"), false, (filename) => filename === "popup.html", onChange),
    watchStaticPath(resolve(root, "assets"), true, () => true, onChange)
  ];

  return () => {
    for (const watcher of watchers) {
      watcher.close();
    }
  };
}

function watchStaticPath(path, recursive, shouldCopy, onChange) {
  return watchFs(path, { persistent: true, recursive }, (_eventType, filename) => {
    const watchedFilename = normalizeWatchedFilename(filename);
    if (watchedFilename === "" || shouldCopy(watchedFilename)) {
      onChange();
    }
  });
}

function normalizeWatchedFilename(filename) {
  if (!filename) {
    return "";
  }
  return normalize(filename.toString()).replaceAll("\\", "/");
}
