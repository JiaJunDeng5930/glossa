import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Page } from "@playwright/test";

import { DEFAULT_SETTINGS, type GlossaSettings, type VocabularyRecord } from "../../src/shared/types";

export type UiPageName = "options" | "onboarding" | "popup";

export async function loadUiPage(page: Page, name: UiPageName): Promise<void> {
  const pagePath = resolve(`dist/${name}/${name}.html`);
  const html = await readFile(pagePath, "utf8");
  const styles = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"[^>]*>/g)].map((match) => match[1]!);
  const withoutAssets = html
    .replace(/<link[^>]+rel="stylesheet"[^>]+href="[^"]+"[^>]*>/g, "")
    .replace(new RegExp(`<script[^>]+src="\\.\\./${name}\\.js"[^>]*><\\/script>`), "");
  await page.setContent(withoutAssets);
  for (const href of styles) {
    await page.addStyleTag({ path: resolve(dirname(pagePath), href) });
  }
}

export interface UiRuntimeOptions {
  settings?: GlossaSettings;
  knownRecords?: VocabularyRecord[];
  deferredTypes?: string[];
  failTypes?: string[];
  failOnceTypes?: string[];
}

/** Install a transport-shaped Chrome stub. It owns only RPC fixtures; it does not model IndexedDB. */
export async function installUiRuntime(page: Page, options: UiRuntimeOptions = {}): Promise<void> {
  await page.evaluate((initial) => {
    const requests: Array<{ type: string; payload: unknown }> = [];
    const listeners: Array<(changes: Record<string, unknown>, areaName: string) => void> = [];
    const pending = new Map<string, Array<() => void>>();
    const deferredTypes = new Set(initial.deferredTypes);
    const failTypes = new Set(initial.failTypes);
    const failOnceTypes = new Set(initial.failOnceTypes);
    const failedOnceTypes = new Set<string>();
    let settings = structuredClone(initial.settings);
    let knownRecords = structuredClone(initial.knownRecords);
    const response = (request: { requestId: string; source: string }, type: string, payload: unknown): unknown => ({
      type,
      version: 1,
      requestId: request.requestId,
      source: "service-worker",
      target: request.source,
      createdAt: Date.now(),
      payload
    });
    const patchSettings = (patch: Record<string, unknown>): void => {
      const merge = (target: Record<string, unknown>, update: Record<string, unknown>): void => {
        for (const [key, value] of Object.entries(update)) {
          if (value && typeof value === "object" && !Array.isArray(value)) {
            const child = (target[key] ??= {}) as Record<string, unknown>;
            merge(child, value as Record<string, unknown>);
          } else if (value === null && key === "apiKey") {
            delete target[key];
          } else {
            target[key] = value;
          }
        }
      };
      merge(settings as unknown as Record<string, unknown>, patch);
    };
    const handle = (request: { type: string; requestId: string; source: string; payload: Record<string, unknown> }, callback: (value: unknown) => void): void => {
      requests.push({ type: request.type, payload: request.payload });
      if (failTypes.has(request.type) || (failOnceTypes.has(request.type) && !failedOnceTypes.has(request.type))) {
        failedOnceTypes.add(request.type);
        callback(response(request, "error", { reason: "runtime", message: `Fixture rejected ${request.type}`, service: "runtime" }));
        return;
      }
      const run = (): void => {
        if (request.type === "settings.get") {
          callback(response(request, "settings.response", { settings }));
        } else if (request.type === "settings.patch") {
          patchSettings(request.payload.patch as Record<string, unknown>);
          callback(response(request, "settings.response", { settings }));
        } else if (request.type === "known.words.list") {
          callback(response(request, "known.words.list.result", { records: knownRecords }));
        } else if (request.type === "known.words.add") {
          const lemma = String(request.payload.lemma);
          if (!knownRecords.some((record) => record.lemma === lemma)) {
            knownRecords = [...knownRecords, { key: `en:${lemma}`, lang: "en", lemma, surface: lemma, state: "known", lastShownAt: Date.now() }];
          }
          callback(response(request, "known.words.changed", {}));
        } else if (request.type === "known.words.remove") {
          knownRecords = knownRecords.filter((record) => record.lemma !== request.payload.lemma);
          callback(response(request, "known.words.changed", {}));
        } else if (request.type === "known.words.clear") {
          knownRecords = [];
          callback(response(request, "known.words.changed", {}));
        } else if (request.type === "gloss.cache.clear") {
          callback(response(request, "gloss.cache.cleared", {}));
        } else if (request.type === "card.history.reset") {
          callback(response(request, "card.history.reset.ok", {}));
        } else {
          callback(response(request, "error", { reason: "runtime", message: `Unhandled ${request.type}`, service: "runtime" }));
        }
      };
      if (deferredTypes.has(request.type)) {
        const queue = pending.get(request.type) ?? [];
        queue.push(run);
        pending.set(request.type, queue);
      } else {
        run();
      }
    };
    const runtime = {
      lastError: undefined as { message: string } | undefined,
      sendMessage(request: unknown, callback: (value: unknown) => void) {
        handle(request as { type: string; requestId: string; source: string; payload: Record<string, unknown> }, callback);
      }
    };
    Reflect.set(window, "chrome", {
      runtime,
      storage: { onChanged: { addListener(listener: (changes: Record<string, unknown>, areaName: string) => void) { listeners.push(listener); } } }
    });
    Reflect.set(window, "__glossaUiFixture", {
      requests,
      release(type: string) {
        pending.get(type)?.shift()?.();
      },
      setDeferred(type: string, deferred: boolean) {
        if (deferred) deferredTypes.add(type);
        else deferredTypes.delete(type);
      },
      emitSettings(next: GlossaSettings) {
        settings = structuredClone(next);
        for (const listener of listeners) listener({ settings: { newValue: settings } }, "local");
      },
    });
  }, {
    settings: options.settings ?? DEFAULT_SETTINGS,
      knownRecords: options.knownRecords ?? [],
    deferredTypes: options.deferredTypes ?? [],
    failTypes: options.failTypes ?? [],
    failOnceTypes: options.failOnceTypes ?? []
  });
}

export async function installPopupChrome(page: Page, options: {
  shortcut?: string;
  enabled?: boolean;
  toggleError?: boolean;
  malformedToggle?: boolean;
  probeFailures?: number;
  unavailable?: boolean;
} = {}): Promise<void> {
  await page.evaluate((initial) => {
    const sent: unknown[] = [];
    let probeAttempts = 0;
    Reflect.set(window, "__glossaTabMessages", sent);
    Reflect.set(window, "__glossaPopupClosed", false);
    Reflect.set(window, "__glossaProbeAttempts", () => probeAttempts);
    window.close = () => {
      Reflect.set(window, "__glossaPopupClosed", true);
    };
    Reflect.set(window, "chrome", {
      runtime: {
        openOptionsPage() {},
        lastError: undefined,
        sendMessage(request: { requestId: string; source: string; type: string }, callback: (value: unknown) => void) {
          if (request.type === "settings.get") {
            callback({ type: "settings.response", version: 1, requestId: request.requestId, source: "service-worker", target: request.source, createdAt: Date.now(), payload: { settings: initial.settings } });
          }
        }
      },
      tabs: {
        async query() { return [{ id: 11 }]; },
        async sendMessage(tabId: number, message: unknown, transportOptions?: unknown) {
          sent.push(transportOptions ? { tabId, message, options: transportOptions } : { tabId, message });
          const type = (message as { type?: string }).type;
          if (initial.unavailable) throw new Error("Could not establish connection. Receiving end does not exist.");
          if (type === "glossa.getTranslationState") {
            probeAttempts += 1;
            if (probeAttempts <= initial.probeFailures) throw new Error("Could not establish connection. Receiving end does not exist.");
            return { ok: true, enabled: initial.enabled };
          }
          if (type === "glossa.toggleTranslationState" && initial.toggleError) return { ok: false, error: { reason: "timeout", message: "runtime timeout", service: "runtime" } };
          if (type === "glossa.toggleTranslationState" && initial.malformedToggle) return { ok: false };
          return { ok: true, enabled: !initial.enabled };
        }
      }
    });
  }, {
    settings: { ...DEFAULT_SETTINGS, translateShortcutKey: options.shortcut ?? DEFAULT_SETTINGS.translateShortcutKey },
    enabled: options.enabled ?? false,
    toggleError: options.toggleError ?? false,
    malformedToggle: options.malformedToggle ?? false,
    probeFailures: options.probeFailures ?? 0,
    unavailable: options.unavailable ?? false
  });
}
