// @vitest-environment node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { EcdictDictionary, dictionaryIdentity } from "../../../src/shared/services/dictionary";

const assetUrl = (path: string) => path;
const lookupWord = (word: string) => ({ surface: word, lemma: word.toLowerCase() });

function assetFetch() {
  return vi.fn(async (url: string | URL | Request) => new Response(await readFile(resolve(String(url)))));
}

function dictionary(fetchImpl: ReturnType<typeof assetFetch>): EcdictDictionary {
  return new EcdictDictionary({ assetUrl, fetchImpl: fetchImpl as typeof fetch });
}

describe("ECDICT dictionary", () => {
  it("uses the versioned packaged dictionary and returns every bank sense with stable identity", async () => {
    const fetchImpl = assetFetch();
    const client = dictionary(fetchImpl);
    expect(client).toMatchObject(dictionaryIdentity);
    const first = await client.lookup(lookupWord("Bank"));
    expect(first.kind).toBe("found");
    if (first.kind !== "found") throw new Error("Expected dictionary entry");
    expect(first.senses.map((sense) => [sense.definition, sense.partOfSpeech])).toEqual([
      ["银行", "n."], ["堤", "n."], ["岸", "n."], ["[医] 库", undefined]
    ]);
    expect(new Set(first.senses.map((sense) => sense.id)).size).toBe(first.senses.length);
    expect(await client.lookup(lookupWord("bank"))).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("combines a word form's own senses with its base senses across partitions", async () => {
    const client = dictionary(assetFetch());
    const banks = await client.lookup(lookupWord("banks"));
    expect(banks.kind === "found" && banks.senses.some((sense) => sense.definition === "[医] 库")).toBe(true);
    expect(banks.kind === "found" && banks.senses.some((sense) => sense.definition === "堤（bank的复数形式）")).toBe(true);
    const went = await client.lookup(lookupWord("went"));
    expect(went.kind === "found" && went.senses.some((sense) => sense.definition === "go的过去式")).toBe(true);
    expect(went.kind === "found" && went.senses.some((sense) => sense.definition === "达到")).toBe(true);
    const running = await client.lookup(lookupWord("running"));
    expect(running.kind === "found" && running.senses.some((sense) => sense.definition === "流动的")).toBe(true);
    expect(running.kind === "found" && running.senses.some((sense) => sense.definition === "驾驶")).toBe(true);
  });

  it("resolves reverse exchange mappings for forms absent as source headwords", async () => {
    const client = dictionary(assetFetch());
    const result = await client.lookup(lookupWord("actioned"));
    expect(result.kind === "found" && result.senses.some((sense) => sense.definition === "行动")).toBe(true);
  });

  it("preserves parenthetical commas and never silently caps large candidate sets", async () => {
    const original = JSON.parse(gunzipSync(await readFile("assets/dictionaries/ecdict/b.json.gz")).toString()) as Record<string, [string[], string[]]>;
    original.bank = [[`n. 带有（甲,乙）的词义,第二项;第三项\\n${Array.from({ length: 260 }, (_, index) => `候选${index}`).join("，")}`], []];
    const fetchImpl = vi.fn(async () => new Response(gzipSync(JSON.stringify(original))));
    const result = await dictionary(fetchImpl).lookup(lookupWord("bank"));
    expect(result.kind).toBe("found");
    if (result.kind !== "found") throw new Error("Expected dictionary entry");
    expect(result.senses).toHaveLength(263);
    expect(result.senses[0]).toMatchObject({ definition: "带有（甲,乙）的词义", partOfSpeech: "n." });
    expect(result.senses.at(-1)?.definition).toBe("候选259");
  });

  it("returns missing only for an absent entry or unsupported word shape", async () => {
    const fetchImpl = assetFetch();
    const client = dictionary(fetchImpl);
    expect(await client.lookup(lookupWord("glossanonexistentword"))).toEqual({ kind: "missing" });
    expect(await client.lookup(lookupWord("1+2"))).toEqual({ kind: "missing" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports asset failures as diagnostics and retries the next lookup", async () => {
    const fetchImpl = assetFetch();
    fetchImpl.mockImplementationOnce(async () => new Response("unavailable", { status: 503 }));
    const client = dictionary(fetchImpl);
    await expect(client.lookup(lookupWord("bank"))).rejects.toMatchObject({ payload: { reason: "service-error", service: "dictionary", status: 503 } });
    expect((await client.lookup(lookupWord("bank"))).kind).toBe("found");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["corrupt gzip", () => new Response("broken archive")],
    ["invalid partition", () => new Response(gzipSync(JSON.stringify({ bank: "not an entry" })))],
    ["unparseable JSON", () => new Response(gzipSync("{"))]
  ])("reports %s as a diagnostic instead of missing", async (_name, response) => {
    const fetchImpl = vi.fn(async () => (response as () => Response)());
    await expect(dictionary(fetchImpl).lookup(lookupWord("bank"))).rejects.toMatchObject({ payload: { reason: "invalid-response", service: "dictionary" } });
  });

  it("isolates subscriber cancellation from a shared partition load", async () => {
    let release!: (response: Response) => void;
    const fetchImpl = vi.fn(async () => new Promise<Response>((resolve) => { release = resolve; }));
    const client = dictionary(fetchImpl);
    const controller = new AbortController();
    const first = client.lookup(lookupWord("bank"), controller.signal);
    const rejection = expect(first).rejects.toMatchObject({ name: "AbortError" });
    const second = client.lookup(lookupWord("bank"));
    controller.abort();
    await rejection;
    release(new Response(await readFile("assets/dictionaries/ecdict/b.json.gz")));
    expect((await second).kind).toBe("found");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((await client.lookup(lookupWord("bank"))).kind).toBe("found");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
