# Chrome Extension Debugability Implementation Patterns

These patterns are templates. Adapt names, storage keys, privacy rules, and Chrome version assumptions to the project.

## Message envelope

```js
export function createMessage(type, payload, source, target) {
  return {
    type,
    version: 1,
    requestId: crypto.randomUUID(),
    source,
    target,
    createdAt: Date.now(),
    payload,
  };
}

export function validateMessage(message) {
  if (!message || typeof message !== "object") throw new Error("Invalid message");
  if (typeof message.type !== "string") throw new Error("Missing message.type");
  if (message.version !== 1) throw new Error("Unsupported message.version");
  if (typeof message.requestId !== "string") throw new Error("Missing message.requestId");
  return message;
}
```

## Structured trace helper

```js
const manifest = chrome.runtime.getManifest();

function sanitizeUrl(input) {
  if (!input) return undefined;
  try {
    const url = new URL(input);
    return `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
}

export function trace(event) {
  const safeEvent = {
    ts: new Date().toISOString(),
    extensionVersion: manifest.version,
    component: event.component,
    operation: event.operation,
    requestId: event.requestId,
    tabId: event.tabId,
    frameId: event.frameId,
    documentId: event.documentId,
    origin: event.origin,
    url: sanitizeUrl(event.url),
    result: event.result,
    error: event.error && {
      name: event.error.name,
      message: event.error.message,
      stack: event.error.stack,
    },
  };

  console[event.result === "error" ? "error" : "debug"]("[extension-trace]", safeEvent);
  return safeEvent;
}
```

## Callback-style Chrome API wrapper

```js
export function withLastError(operation, invoke) {
  return new Promise((resolve, reject) => {
    invoke((result) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        const error = new Error(lastError.message || `${operation} failed`);
        error.operation = operation;
        reject(error);
        return;
      }
      resolve(result);
    });
  });
}

// Example:
// const tab = await withLastError("tabs.get", (done) => chrome.tabs.get(tabId, done));
```

## Service worker-safe message listener

```js
let initPromise;

function initOnce() {
  if (!initPromise) {
    initPromise = (async () => {
      // Load durable configuration here. Do not delay listener registration.
      return chrome.storage.local.get(["settings"]);
    })();
  }
  return initPromise;
}

chrome.runtime.onMessage.addListener((rawMessage, sender, sendResponse) => {
  (async () => {
    const message = validateMessage(rawMessage);
    await initOnce();

    trace({
      component: "service-worker",
      operation: message.type,
      requestId: message.requestId,
      tabId: sender.tab?.id,
      frameId: sender.frameId,
      documentId: sender.documentId,
      origin: sender.origin,
      url: sender.url,
      result: "ok",
    });

    sendResponse({ requestId: message.requestId, ok: true });
  })().catch((error) => {
    sendResponse({ ok: false, error: { name: error.name, message: error.message } });
  });

  return true;
});
```

## Diagnostic ring buffer in chrome.storage.session

```js
const DIAGNOSTIC_KEY = "debug.traceBuffer.v1";
const MAX_EVENTS = 200;

export async function appendDiagnostic(event) {
  const current = await chrome.storage.session.get(DIAGNOSTIC_KEY);
  const buffer = Array.isArray(current[DIAGNOSTIC_KEY]) ? current[DIAGNOSTIC_KEY] : [];
  buffer.push(event);
  await chrome.storage.session.set({
    [DIAGNOSTIC_KEY]: buffer.slice(-MAX_EVENTS),
  });
}

export async function exportDiagnostics() {
  const current = await chrome.storage.session.get(DIAGNOSTIC_KEY);
  return current[DIAGNOSTIC_KEY] || [];
}
```

## Content script to service worker call with timeout

```js
export async function sendRuntimeMessage(message, timeoutMs = 5000) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Message timeout: ${message.type}`)), timeoutMs);
  });

  try {
    return await Promise.race([
      chrome.runtime.sendMessage(message),
      timeout,
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}
```

## MV3 lifecycle test shape

```js
// Pseudocode for Puppeteer/Playwright-style tests.
// 1. Load the built extension with a fixed extension ID or discover the ID.
// 2. Trigger a popup/content-script action that sends a message to the service worker.
// 3. Confirm the expected result.
// 4. Terminate or restart the extension service worker.
// 5. Repeat the same action.
// 6. Assert that durable state survived and a new requestId was logged.
```

## DNR development diagnostics

```js
// Development-only pattern. Keep debug permissions out of production if unnecessary.
async function inspectDnrForRequest(request) {
  if (!chrome.declarativeNetRequest?.testMatchOutcome) return [];
  const result = await chrome.declarativeNetRequest.testMatchOutcome(request);
  return result.matchedRules?.map((rule) => ({
    ruleId: rule.ruleId,
    rulesetId: rule.rulesetId,
  })) || [];
}
```
