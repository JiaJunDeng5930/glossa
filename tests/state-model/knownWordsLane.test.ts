import { describe, expect, it } from "vitest";

import { createKnownWordsOperationLane } from "../../src/options/knownWordsOperationLane";
import { deferred, drainMicrotasks } from "./asyncHarness";

describe("known-word UI operation state transitions", () => {
  it("serializes refresh, add, remove and clear so the final view matches storage", async () => {
    const lane = createKnownWordsOperationLane();
    const releaseRefresh = deferred();
    const ledger: string[] = [];
    const rendered: string[][] = [];
    let stored = ["alpha", "beta"];

    const refresh = lane.run(async () => {
      ledger.push("refresh:start");
      const snapshot = [...stored];
      await releaseRefresh.promise;
      rendered.push(snapshot);
      ledger.push("refresh:end");
    });
    const add = lane.run(async () => {
      ledger.push("add:start");
      stored = [...stored, "gamma"];
      rendered.push([...stored]);
      ledger.push("add:end");
    });
    const remove = lane.run(async () => {
      ledger.push("remove:start");
      stored = stored.filter((word) => word !== "alpha");
      rendered.push([...stored]);
      ledger.push("remove:end");
    });
    const clear = lane.run(async () => {
      ledger.push("clear:start");
      stored = [];
      rendered.push([...stored]);
      ledger.push("clear:end");
    });

    await drainMicrotasks();
    const beforeRelease = { ledger: [...ledger], stored: [...stored], rendered: rendered.map((value) => [...value]) };
    releaseRefresh.resolve();
    await Promise.all([refresh, add, remove, clear]);

    expect(beforeRelease).toEqual({
      ledger: ["refresh:start"],
      stored: ["alpha", "beta"],
      rendered: []
    });
    expect(ledger).toEqual([
      "refresh:start", "refresh:end",
      "add:start", "add:end",
      "remove:start", "remove:end",
      "clear:start", "clear:end"
    ]);
    expect(rendered.at(-1)).toEqual(stored);
    expect(stored).toEqual([]);
  });
});
