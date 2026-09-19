import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assetRoot = resolve(root, "assets/dictionaries/ecdict");
const sourceCommit = "bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b";
const sourceRoot = `https://raw.githubusercontent.com/skywind3000/ECDICT/${sourceCommit}`;
const sourceSha256 = "1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf";
const licenseSha256 = "f8552dd246f61a4e064569eae6194a01c6b3d63b03bf27c6ca863593c549ed0f";
const dictionaryVersion = `${sourceCommit}-v1`;
const wordPattern = /^[a-z]+(?:[-'][a-z]+)*$/;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--check")) await checkEcdictAssets();
  else await generateAssets();
}

async function generateAssets() {
  const source = await readInput("--source", "ecdict.csv");
  const license = await readInput("--license", "LICENSE");
  assertHash(source, sourceSha256, "ECDICT source");
  assertHash(license, licenseSha256, "ECDICT license");
  const rows = parseCsv(source.toString("utf8"));
  const headers = rows.shift();
  const wordColumn = headers.indexOf("word");
  const translationColumn = headers.indexOf("translation");
  const exchangeColumn = headers.indexOf("exchange");
  if ([wordColumn, translationColumn, exchangeColumn].includes(-1)) throw new Error("ECDICT source columns changed.");
  const entries = new Map();
  const getEntry = (word) => {
    if (!entries.has(word)) entries.set(word, [new Set(), new Set()]);
    return entries.get(word);
  };
  let translatedRows = 0;
  for (const row of rows) {
    const word = row[wordColumn].trim().toLowerCase();
    if (!wordPattern.test(word)) continue;
    const [translations, bases] = getEntry(word);
    const translation = row[translationColumn].trim();
    if (translation) {
      translations.add(translation);
      translatedRows += 1;
    }
    for (const exchange of row[exchangeColumn].split("/")) {
      const separator = exchange.indexOf(":");
      if (separator === -1) continue;
      const kind = exchange.slice(0, separator);
      for (const value of exchange.slice(separator + 1).split(",")) {
        const related = value.trim().toLowerCase();
        if (related === word || !wordPattern.test(related)) continue;
        if (kind === "0") bases.add(related);
        // Reverse inflection mappings also cover forms absent as CSV headwords.
        if (["p", "d", "i", "3", "r", "t", "s"].includes(kind)) getEntry(related)[1].add(word);
      }
    }
  }
  await mkdir(assetRoot, { recursive: true });
  await writeFile(resolve(assetRoot, "LICENSE"), license);
  const partitions = {};
  const sorted = [...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  for (const initial of "abcdefghijklmnopqrstuvwxyz") {
    const partition = Object.fromEntries(sorted.filter(([word]) => word[0] === initial).map(([word, [translations, bases]]) => [word, [[...translations], [...bases].filter((base) => entries.has(base)).sort()]]));
    const output = gzipSync(Buffer.from(JSON.stringify(partition)), { level: 9 });
    const file = `${initial}.json.gz`;
    await writeFile(resolve(assetRoot, file), output);
    partitions[initial] = { file, sha256: sha256(output), bytes: output.length, entries: Object.keys(partition).length };
  }
  await writeFile(resolve(assetRoot, "manifest.json"), `${JSON.stringify({
    id: "ecdict",
    version: dictionaryVersion,
    format: 1,
    source: { repository: "https://github.com/skywind3000/ECDICT", commit: sourceCommit, url: `${sourceRoot}/ecdict.csv`, sha256: sourceSha256, rows: rows.length },
    license: { spdx: "MIT", file: "LICENSE", url: `${sourceRoot}/LICENSE`, sha256: licenseSha256 },
    coverage: { headwordPattern: "[A-Za-z]+(?:[-'][A-Za-z]+)*", translatedRows, entries: entries.size, inflections: "Original forms (exchange 0) and reverse mappings for p,d,i,3,r,t,s; all source translations retained." },
    partitions
  }, null, 2)}\n`);
  await checkEcdictAssets();
}

export async function checkEcdictAssets() {
  const manifest = JSON.parse(await readFile(resolve(assetRoot, "manifest.json"), "utf8"));
  if (manifest.id !== "ecdict" || manifest.version !== dictionaryVersion || manifest.format !== 1 || manifest.source.sha256 !== sourceSha256) throw new Error("ECDICT manifest identity or source mismatch.");
  assertHash(await readFile(resolve(assetRoot, "LICENSE")), licenseSha256, "ECDICT license");
  const expectedFiles = new Set(["manifest.json", "LICENSE"]);
  const words = new Set();
  const baseWords = new Set();
  let bytes = 0;
  for (const [initial, partition] of Object.entries(manifest.partitions)) {
    if (!/^[a-z]$/.test(initial) || partition.file !== `${initial}.json.gz`) throw new Error("Invalid ECDICT partition path.");
    expectedFiles.add(partition.file);
    const compressed = await readFile(resolve(assetRoot, partition.file));
    assertHash(compressed, partition.sha256, `ECDICT partition ${initial}`);
    if (compressed.length !== partition.bytes) throw new Error(`ECDICT partition size mismatch: ${initial}`);
    bytes += compressed.length;
    const content = JSON.parse(gunzipSync(compressed).toString("utf8"));
    if (Object.keys(content).length !== partition.entries) throw new Error(`ECDICT entry count mismatch: ${initial}`);
    for (const [word, entry] of Object.entries(content)) {
      if (!wordPattern.test(word) || word[0] !== initial || !Array.isArray(entry) || entry.length !== 2 || !entry.every((values) => Array.isArray(values) && values.every((value) => typeof value === "string" && value.trim() !== ""))) throw new Error(`Invalid ECDICT entry: ${word}`);
      words.add(word);
      entry[1].forEach((base) => baseWords.add(base));
    }
  }
  if (Object.keys(manifest.partitions).length !== 26 || words.size !== manifest.coverage.entries) throw new Error("ECDICT coverage mismatch.");
  for (const word of baseWords) if (!words.has(word)) throw new Error(`Unresolved ECDICT base: ${word}`);
  for (const file of await readdir(assetRoot)) if (!expectedFiles.has(file)) throw new Error(`Unclassified ECDICT asset: ${file}`);
  console.log(`ECDICT verified: ${words.size} entries, 26 partitions, ${(bytes / 1024 / 1024).toFixed(2)} MiB compressed.`);
}

async function readInput(flag, file) {
  const position = process.argv.indexOf(flag);
  if (position !== -1) {
    const path = process.argv[position + 1];
    if (!path || path.startsWith("--")) throw new Error(`Missing path after ${flag}`);
    return readFile(resolve(path));
  }
  const response = await fetch(`${sourceRoot}/${file}`);
  if (!response.ok) throw new Error(`ECDICT download failed: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function assertHash(value, expected, label) {
  if (sha256(value) !== expected) throw new Error(`${label} SHA-256 mismatch.`);
}

function parseCsv(source) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"') {
      if (quoted && source[index + 1] === '"') { field += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(field); field = "";
    } else if (char === "\n" && !quoted) {
      row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = "";
    } else field += char;
  }
  if (quoted) throw new Error("Unterminated ECDICT CSV quoted field.");
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}
