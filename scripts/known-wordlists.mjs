import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { KNOWN_WORD_LISTS } from "../src/shared/knownWordLists.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const metadata = JSON.parse(await readFile(resolve(root, "assets/known-wordlists/sources.json"), "utf8"));
const wordPattern = /^[a-z]+(?:[-'][a-z]+)*$/;
const descriptorIds = new Set(KNOWN_WORD_LISTS.map(({ id }) => id));
if (descriptorIds.size !== KNOWN_WORD_LISTS.length
    || new Set(KNOWN_WORD_LISTS.map(({ file }) => file)).size !== KNOWN_WORD_LISTS.length
    || KNOWN_WORD_LISTS.some(({ file }) => file !== `assets/known-wordlists/${basename(file)}` || !file.endsWith(".txt"))) {
  throw new Error("Known-word-list descriptors must have unique IDs and unique asset filenames.");
}

const [command, ...args] = process.argv.slice(2);
if (command !== "--check" && command !== "--derive") {
  throw new Error("Usage: node scripts/known-wordlists.mjs --check | --derive --output-dir <directory> [--source-file <canonical-json>]");
}
const options = parseOptions(args);
if (command === "--check" && Object.keys(options).length > 0) {
  throw new Error("--check always compares the repository's canonical source and assets; it takes no options.");
}
if (command === "--derive" && !options["--output-dir"]) {
  throw new Error("--derive requires --output-dir.");
}
const sourcePath = resolve(root, options["--source-file"] ?? metadata._canonical.path);
const sourceBytes = await readFile(sourcePath);
const outputs = generateLists(JSON.parse(sourceBytes.toString("utf8")));

if (command === "--check") {
  const errors = [];
  if (digest(sourceBytes) !== metadata._canonical.sha256) errors.push("Canonical source SHA-256 differs from metadata.");
  const metadataIds = Object.keys(metadata).filter((id) => id !== "_canonical");
  if (metadataIds.length !== descriptorIds.size || metadataIds.some((id) => !descriptorIds.has(id))) {
    errors.push("Source metadata must cover exactly the known-word-list descriptors.");
  }
  for (const { id, file } of KNOWN_WORD_LISTS) {
    const generated = outputs.get(id);
    const record = metadata[id]?.asset;
    if (record?.sha256 !== digest(generated.bytes) || record?.lineCount !== generated.count) {
      errors.push(`${id}: generated hash or line count differs from metadata.`);
    }
    try {
      const actual = await readFile(resolve(root, file));
      if (!actual.equals(generated.bytes)) errors.push(`${id}: checked-in asset differs byte-for-byte from canonical output.`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      errors.push(`${id}: missing asset ${file}.`);
    }
  }
  if (errors.length > 0) throw new Error(`Known-wordlist validation failed:\n${errors.join("\n")}`);
  console.log(`Rebuilt and byte-compared ${outputs.size} known-wordlist assets from the canonical source.`);
} else {
  const outputDir = resolve(options["--output-dir"]);
  await mkdir(outputDir, { recursive: true });
  for (const { id, file } of KNOWN_WORD_LISTS) {
    await writeFile(resolve(outputDir, basename(file)), outputs.get(id).bytes);
  }
  console.log(`Derived ${outputs.size} known-wordlists in ${outputDir}.`);
}

// Validate the source at the generation boundary so every command shares the same contract.
function generateLists(document) {
  if (document.schemaVersion !== 1 || !Array.isArray(document.entries)) {
    throw new Error("Canonical source must contain schemaVersion 1 and an entries array.");
  }
  const wordsByList = new Map(KNOWN_WORD_LISTS.map(({ id }) => [id, []]));
  let previousWord = "";
  for (const entry of document.entries) {
    if (!entry || typeof entry.word !== "string" || !wordPattern.test(entry.word)) {
      throw new Error(`Canonical source contains an invalid word: ${JSON.stringify(entry)}`);
    }
    if (entry.word <= previousWord) throw new Error(`Canonical words must be unique and sorted by code point: ${entry.word}`);
    previousWord = entry.word;
    if (!Array.isArray(entry.lists) || entry.lists.length === 0
        || new Set(entry.lists).size !== entry.lists.length
        || entry.lists.some((id) => !descriptorIds.has(id))) {
      throw new Error(`Invalid or duplicate list membership for ${entry.word}.`);
    }
    for (const id of entry.lists) wordsByList.get(id).push(entry.word);
  }
  const outputs = new Map();
  for (const [id, words] of wordsByList) {
    if (words.length === 0) throw new Error(`Canonical source has no entries for descriptor ${id}.`);
    outputs.set(id, { bytes: Buffer.from(`${words.join("\n")}\n`), count: words.length });
  }
  return outputs;
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!["--output-dir", "--source-file"].includes(key) || key in options || !value || value.startsWith("--")) {
      throw new Error(`Invalid option: ${key}`);
    }
    options[key] = value;
  }
  return options;
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
