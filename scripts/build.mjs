import { watch as watchFs } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { checkEcdictAssets } from "./ecdict.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
const watch = process.argv.includes("--watch");
const packagePath = resolve(root, "package.json");

const entryPoints = {
  content: resolve(root, "src/content/index.ts"),
  background: resolve(root, "src/background/index.ts"),
  onboarding: resolve(root, "src/onboarding/onboarding.ts"),
  options: resolve(root, "src/options/options.ts"),
  popup: resolve(root, "src/popup/popup.ts")
};

const staticPages = [
  ["src/onboarding/onboarding.html", "onboarding/onboarding.html", "onboarding.js"],
  ["src/options/options.html", "options/options.html", "options.js"],
  ["src/popup/popup.html", "popup/popup.html", "popup.js"]
];

const dictionaryManifest = JSON.parse(await readFile(resolve(root, "assets/dictionaries/ecdict/manifest.json"), "utf8"));
const dictionaryAssetPaths = ["manifest.json", dictionaryManifest.license.file, ...Object.values(dictionaryManifest.partitions).map((partition) => partition.file)]
  .map((file) => `dictionaries/ecdict/${file}`);

const publishedAssetPaths = [
  ...dictionaryAssetPaths,
  "icon-16.png",
  "icon-32.png",
  "icon-48.png",
  "icon-128.png",
  "logo.png",
  "onboarding.css",
  "options.css",
  "popup.css",
  "known-wordlists/cet4.txt",
  "known-wordlists/cet6.txt",
  "known-wordlists/coca-20000.txt",
  "known-wordlists/gre.txt",
  "known-wordlists/junior-high.txt",
  "known-wordlists/senior-high.txt",
  "known-wordlists/toefl.txt",
  "known-wordlists/sources.json"
];

const expectedEntryOutputs = Object.keys(entryPoints).flatMap((name) => [`${name}.js`, `${name}.js.map`]);

await checkEcdictAssets();
await rm(dist, { recursive: true, force: true });

const context = await esbuild.context({
  entryPoints,
  bundle: true,
  format: "esm",
  target: "chrome120",
  sourcemap: true,
  outdir: dist,
  logLevel: "info"
});

await copyStaticFiles();

if (watch) {
  await context.rebuild();
  await validateBuildArtifacts();
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
  await validateBuildArtifacts();
}

async function copyStaticFiles() {
  await mkdir(dist, { recursive: true });
  await mkdir(resolve(dist, "onboarding"), { recursive: true });
  await mkdir(resolve(dist, "options"), { recursive: true });
  await mkdir(resolve(dist, "popup"), { recursive: true });
  await writeManifest();
  for (const [source, target] of staticPages) {
    await copyFile(resolve(root, source), resolve(dist, target));
  }
  await rm(resolve(dist, "assets"), { recursive: true, force: true });
  await copyPublishedAssets();
  await writeThemeCss();
}

async function writeManifest() {
  const packageJson = await readPackageJson();
  if (typeof packageJson.version !== "string" || packageJson.version === "") {
    throw new Error("package.json must contain a non-empty version.");
  }
  const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));
  if (Object.hasOwn(manifest, "version")) {
    throw new Error("manifest.json is a template; keep the release version in package.json only.");
  }
  manifest.version = packageJson.version;
  await writeFile(resolve(dist, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function copyPublishedAssets() {
  const sourceRoot = resolve(root, "assets");
  const actualAssetPaths = await collectRelativeFiles(sourceRoot);
  const expected = new Set(publishedAssetPaths);
  const unexpected = actualAssetPaths.filter((path) => !expected.has(path));
  if (unexpected.length > 0) {
    throw new Error(`Unclassified assets would be omitted from the extension: ${unexpected.join(", ")}`);
  }

  for (const assetPath of publishedAssetPaths) {
    const target = resolve(dist, "assets", assetPath);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(resolve(sourceRoot, assetPath), target);
  }
}

async function validateBuildArtifacts() {
  const packageJson = await readPackageJson();
  const manifest = JSON.parse(await readFile(resolve(dist, "manifest.json"), "utf8"));
  if (manifest.version !== packageJson.version) {
    throw new Error(`Generated manifest version ${manifest.version} does not match package.json ${packageJson.version}.`);
  }

  for (const output of expectedEntryOutputs) {
    await assertFile(resolve(dist, output), `entry output ${output}`);
  }
  for (const [, target, script] of staticPages) {
    await assertFile(resolve(dist, target), `static page ${target}`);
    await assertFile(resolve(dist, script), `static page script ${script}`);
  }
  for (const assetPath of [...publishedAssetPaths, "theme.css"]) {
    await assertFile(resolve(dist, "assets", assetPath), `asset ${assetPath}`);
  }

  const manifestPaths = collectManifestPaths(manifest);
  for (const manifestPath of manifestPaths.files) {
    await assertFile(resolveManifestPath(manifestPath), `manifest reference ${manifestPath}`);
  }
  const distFiles = await collectRelativeFiles(dist);
  const actualEntryOutputs = distFiles.filter((path) => /^(?:[^/]+)\.js(?:\.map)?$/.test(path));
  const unexpectedEntryOutputs = actualEntryOutputs.filter((path) => !expectedEntryOutputs.includes(path));
  if (unexpectedEntryOutputs.length > 0) {
    throw new Error(`Unregistered entry outputs in dist: ${unexpectedEntryOutputs.join(", ")}`);
  }
  for (const pattern of manifestPaths.patterns) {
    const matcher = globToRegExp(pattern);
    if (!distFiles.some((path) => matcher.test(path))) {
      throw new Error(`Manifest resource pattern ${pattern} matches no file in dist.`);
    }
  }
}

async function readPackageJson() {
  return JSON.parse(await readFile(packagePath, "utf8"));
}

function collectManifestPaths(manifest) {
  const files = [];
  const patterns = [];
  const addFile = (path) => {
    if (typeof path === "string") files.push(path);
  };
  const addIconPaths = (icons) => {
    if (icons && typeof icons === "object") {
      for (const path of Object.values(icons)) addFile(path);
    }
  };

  addIconPaths(manifest.icons);
  addFile(manifest.background?.service_worker);
  for (const script of manifest.content_scripts ?? []) {
    for (const path of script.js ?? []) addFile(path);
  }
  addFile(manifest.options_page);
  addFile(manifest.action?.default_popup);
  addIconPaths(manifest.action?.default_icon);
  for (const resourceGroup of manifest.web_accessible_resources ?? []) {
    for (const resource of resourceGroup.resources ?? []) {
      if (typeof resource !== "string") continue;
      (resource.includes("*") ? patterns : files).push(resource);
    }
  }
  return { files, patterns };
}

function resolveManifestPath(path) {
  if (path.startsWith("/") || path.includes("\\")) {
    throw new Error(`Manifest path must be relative and use forward slashes: ${path}`);
  }
  const target = resolve(dist, path);
  if (target !== dist && !target.startsWith(`${dist}${sep}`)) {
    throw new Error(`Manifest path escapes dist: ${path}`);
  }
  return target;
}

async function assertFile(path, label) {
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error(`${label} is not a file: ${path}`);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error(`Missing ${label}: ${path}`);
    }
    throw error;
  }
}

async function collectRelativeFiles(base) {
  const paths = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = resolve(current, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else {
        paths.push(relative(base, absolute).replaceAll("\\", "/"));
      }
    }
  }
  await visit(base);
  return paths.sort();
}

function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replaceAll("*", ".*")}$`);
}

async function writeThemeCss() {
  const theme = JSON.parse(await readFile(resolve(root, "src/shared/theme.json"), "utf8"));
  const accent = themeString(theme, "accent");
  const accentSoft = themeString(theme, "accentSoft");
  const accentRgb = themeString(theme, "accentRgb");
  const selectionWash = themeString(theme, "selectionWash");
  await writeFile(resolve(dist, "assets/theme.css"), [
    ":root {",
    `  --glossa-theme-accent: ${accent};`,
    `  --glossa-theme-accent-soft: ${accentSoft};`,
    `  --glossa-theme-accent-rgb: ${accentRgb};`,
    `  --glossa-theme-selection-wash: ${selectionWash};`,
    "}",
    ""
  ].join("\n"));
}

function themeString(theme, key) {
  const value = theme[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Theme token ${key} must be a non-empty string.`);
  }
  return value;
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
    watchStaticPath(root, false, (filename) => filename === "manifest.json" || filename === "package.json", onChange),
    watchStaticPath(resolve(root, "src/onboarding"), false, (filename) => filename === "onboarding.html", onChange),
    watchStaticPath(resolve(root, "src/options"), false, (filename) => filename === "options.html", onChange),
    watchStaticPath(resolve(root, "src/popup"), false, (filename) => filename === "popup.html", onChange),
    watchStaticPath(resolve(root, "src/shared"), false, (filename) => filename === "theme.json", onChange),
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
