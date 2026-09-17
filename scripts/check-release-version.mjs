import { readFile } from "node:fs/promises";

const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
if (!tag) {
  throw new Error("A release tag is required (for example: v0.2.0).");
}

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const version = packageJson.version;
if (typeof version !== "string" || version === "") {
  throw new Error("package.json must contain a non-empty version.");
}

const tagVersion = tag.replace(/^v/, "");
if (tagVersion !== version) {
  throw new Error(`Release tag ${tag} must match package.json version ${version}.`);
}

console.log(`Release tag ${tag} matches package.json version ${version}.`);
