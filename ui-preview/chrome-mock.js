(() => {
  const storage = {
    settings: {
      autoTranslateEnabled: true,
      knownWordList: "senior-high",
      appearance: {
        textColor: "#ffffff",
        backgroundColor: "#0f172a",
        cardSuccessBackgroundColor: "#16a34a",
        cardErrorBackgroundColor: "#dc2626",
        backgroundOpacity: 0.9,
        fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
        fontSize: 11
      }
    }
  };

  globalThis.chrome = {
    runtime: {
      lastError: undefined,
      openOptionsPage() {
        const status = document.querySelector("#popup-status");
        if (status) {
          status.value = "设置页使用独立端口预览。";
        }
      },
      sendMessage(message, callback) {
        const response = {
          type: "gloss.cache.cleared",
          version: 1,
          requestId: message?.requestId ?? crypto.randomUUID(),
          source: "service-worker",
          target: "options",
          createdAt: Date.now(),
          payload: {}
        };
        queueMicrotask(() => callback?.(response));
      }
    },
    storage: {
      local: {
        get(keys, callback) {
          queueMicrotask(() => callback(readStorage(keys)));
        },
        set(values, callback) {
          Object.assign(storage, values);
          queueMicrotask(() => callback?.());
        }
      }
    },
    tabs: {
      async query() {
        return [{ id: 1, active: true, currentWindow: true }];
      },
      async sendMessage() {
        return { ok: true };
      }
    }
  };

  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith("http://127.0.0.1:8765")) {
      return mockAnkiResponse(init);
    }
    if (url.includes("api.openai.com") || url.startsWith("http://127.0.0.1:8787")) {
      return jsonResponse({ items: [] });
    }
    return nativeFetch(input, init);
  };

  function readStorage(keys) {
    if (typeof keys === "string") {
      return { [keys]: storage[keys] };
    }
    if (Array.isArray(keys)) {
      return Object.fromEntries(keys.map((key) => [key, storage[key]]));
    }
    if (keys && typeof keys === "object") {
      return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, storage[key] ?? fallback]));
    }
    return { ...storage };
  }

  function mockAnkiResponse(init) {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const resultByAction = {
      version: 6,
      deckNames: ["Glossa", "Default", "Reading"],
      modelNames: ["Basic", "Basic (and reversed card)"],
      modelFieldNames: ["Front", "Back"]
    };
    return jsonResponse({ result: resultByAction[body.action], error: null });
  }

  function jsonResponse(payload) {
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }
})();
