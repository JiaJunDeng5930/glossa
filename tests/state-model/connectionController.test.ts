import { describe, expect, it } from "vitest";

import {
  claimFeedback,
  createAnkiCatalogController,
  createConnectionController,
  createFeedbackChannel,
  type OperationState
} from "../../src/shared/connectionController";
import { createDiagnosticError } from "../../src/shared/errors";
import { deferred, drainMicrotasks } from "./asyncHarness";

describe("UI connection and catalog controllers", () => {
  it("invalidates an older request when settings change and ignores its completion", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const calls: string[] = [];
    const states: Array<OperationState<void>> = [];
    const notifications: Array<{ state: OperationState<void>; operationId: object | undefined }> = [];
    const controller = createConnectionController<{ endpoint: string }>({
      identity: (settings) => settings.endpoint,
      run: async (settings) => {
        calls.push(settings.endpoint);
        await (settings.endpoint === "A" ? first.promise : second.promise);
      },
      errorFallback: { reason: "network", message: "probe failed", service: "ai" }
    }, { endpoint: "A" });
    controller.subscribe((state, operationId) => {
      states.push(state);
      notifications.push({ state, operationId });
    });

    controller.test();
    await drainMicrotasks();
    expect(controller.state.phase).toBe("pending");
    controller.updateSettings({ endpoint: "B" });
    expect(controller.state).toEqual({ phase: "idle" });
    controller.test();
    await drainMicrotasks();
    second.resolve();
    await drainMicrotasks();
    const afterSecond = controller.state;
    expect(afterSecond).toEqual({ phase: "success", key: "B", value: undefined });
    first.resolve();
    await drainMicrotasks();
    expect(controller.state).toBe(afterSecond);
    expect(states.filter((state) => state.phase === "success")).toEqual([afterSecond]);
    const pendingIds = notifications.filter(({ state }) => state.phase === "pending").map(({ operationId }) => operationId);
    expect(pendingIds).toHaveLength(2);
    expect(new Set(pendingIds).size).toBe(2);
    expect(calls).toEqual(["A", "B"]);
  });

  it("keeps A→B→A idle until a new test and permits a same-key retry", async () => {
    const pending = deferred<void>();
    let calls = 0;
    const controller = createConnectionController<{ endpoint: string }>({
      identity: (settings) => settings.endpoint,
      run: async () => {
        calls += 1;
        if (calls === 1) {
          await pending.promise;
        }
      }
    }, { endpoint: "A" });

    controller.test();
    await drainMicrotasks();
    controller.updateSettings({ endpoint: "B" });
    controller.updateSettings({ endpoint: "A" });
    expect(controller.state).toEqual({ phase: "idle" });
    pending.resolve();
    await drainMicrotasks();
    expect(controller.state).toEqual({ phase: "idle" });
    controller.test();
    await drainMicrotasks();
    expect(controller.state.phase).toBe("success");
    expect(calls).toBe(2);
  });

  it("uses explicit error state for synchronous throws and rejected requests", async () => {
    const controller = createConnectionController<{ endpoint: string }>({
      identity: (settings) => settings.endpoint,
      run: async () => {
        throw createDiagnosticError("invalid-response", "bad response", { service: "anki" });
      }
    }, { endpoint: "A" });
    controller.test();
    await drainMicrotasks();
    expect(controller.state).toMatchObject({
      phase: "error",
      error: { reason: "invalid-response", message: "bad response", service: "anki" }
    });
  });

  it("does not start a repeated action while pending and releases on empty catalog", async () => {
    const result = deferred<{ decks: string[]; modelNames: string[] }>();
    let calls = 0;
    const states: Array<OperationState<{ decks: string[]; modelNames: string[] }>> = [];
    const controller = createAnkiCatalogController<{ endpoint: string }, { decks: string[]; modelNames: string[] }>({
      identity: (settings) => settings.endpoint,
      run: async () => {
        calls += 1;
        return result.promise;
      }
    }, { endpoint: "A" });
    controller.subscribe((state) => states.push(state));
    controller.refresh();
    controller.refresh();
    expect(calls).toBe(0);
    await drainMicrotasks();
    expect(calls).toBe(1);
    result.resolve({ decks: [], modelNames: [] });
    await drainMicrotasks();
    expect(controller.state).toEqual({ phase: "success", key: "A", value: { decks: [], modelNames: [] } });
    expect(states.map((state) => state.phase)).toEqual(["idle", "pending", "success"]);
  });

  it("detaches subscribers and ignores a completion after disposal", async () => {
    const result = deferred<void>();
    const states: string[] = [];
    const controller = createConnectionController<{ endpoint: string }>({
      identity: (settings) => settings.endpoint,
      run: async () => result.promise
    }, { endpoint: "A" });
    controller.subscribe((state) => states.push(state.phase));
    controller.test();
    await drainMicrotasks();
    controller.dispose();
    result.resolve();
    await drainMicrotasks();
    expect(states).toEqual(["idle", "pending"]);
  });

  it("keeps controller controls independent while a shared Anki output has one owner", async () => {
    const connectionResult = deferred<void>();
    const catalogResult = deferred<{ decks: string[]; modelNames: string[] }>();
    const connection = createConnectionController<{ endpoint: string }>({
      identity: (settings) => settings.endpoint,
      run: async () => connectionResult.promise
    }, { endpoint: "A" });
    const catalog = createAnkiCatalogController<{ endpoint: string }, { decks: string[]; modelNames: string[] }>({
      identity: (settings) => settings.endpoint,
      run: async () => catalogResult.promise
    }, { endpoint: "A" });
    const feedback = createFeedbackChannel();
    let connectionControl = "";
    let catalogControl = "";
    let status = "";
    connection.subscribe((state, token) => {
      connectionControl = state.phase;
      if (claimFeedback(feedback, state, token)) status = `connection:${state.phase}`;
    });
    catalog.subscribe((state, token) => {
      catalogControl = state.phase;
      if (claimFeedback(feedback, state, token)) status = `catalog:${state.phase}`;
    });

    connection.test();
    catalog.refresh();
    await drainMicrotasks();
    expect(status).toBe("catalog:pending");
    const resetToken = feedback.claimExternal();
    status = "reset:pending";
    connectionResult.resolve();
    await drainMicrotasks();
    expect(connectionControl).toBe("success");
    expect(status).toBe("reset:pending");
    catalogResult.resolve({ decks: ["Default"], modelNames: ["Basic"] });
    await drainMicrotasks();
    expect(catalogControl).toBe("success");
    expect(feedback.owns(resetToken)).toBe(true);
    expect(status).toBe("reset:pending");
  });
});
