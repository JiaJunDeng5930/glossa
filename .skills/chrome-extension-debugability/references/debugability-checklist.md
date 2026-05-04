# Chrome Extension Debugability Checklist

Use this checklist for a complete audit, bug triage session, or pre-release review.

## Architecture map

Record the extension ID, manifest version, extension version, service worker path, declared content scripts, popup/options/side panel/offscreen pages, host permissions, optional permissions, externally connectable settings, DNR rulesets, and test entry points.

For each execution context, identify where logs and errors appear: extension management page, service worker DevTools, popup DevTools, options page DevTools, target page DevTools for content scripts, and Application panel for service worker lifecycle checks.

## Structured trace fields

Require these fields for important events:

- `component`: `service-worker`, `content-script`, `popup`, `options`, `side-panel`, `offscreen`, or `page-injected`.
- `extensionVersion`: from `chrome.runtime.getManifest().version`.
- `requestId`: stable across message hops and async operations.
- `tabId`, `frameId`, `documentId`: include when available.
- `origin` and sanitized URL or URL pattern.
- `operation`: stable operation name, such as `content.extractSelection` or `rules.applySessionRules`.
- `result`: `ok`, `error`, `timeout`, `ignored`, or `matched`.
- `error`: include `name`, `message`, safe stack or stack hash, and `chrome.runtime.lastError?.message` where applicable.

Avoid logging full URLs with query strings, page text, cookies, bearer tokens, authorization headers, form values, or DOM snapshots.

## Manifest V3 service worker

Check that event listeners are registered at module top level. Avoid registering listeners only after awaited initialization. If initialization is required, register first and make handlers await a shared initialization promise.

Check that durable state does not live only in module-level variables. Persist user configuration and cross-session state in `chrome.storage.local`; use `chrome.storage.session` for temporary diagnostic buffers.

Check timer usage. Replace durable `setTimeout` or `setInterval` work with `chrome.alarms`. Short local timers are acceptable only when losing them during service worker termination is harmless.

Check unavailable browser globals. Service workers should not depend on `window`, `document`, direct DOM access, or synchronous `localStorage`.

Verify behavior with DevTools closed. Inspecting the service worker can keep it alive and hide lifecycle bugs.

## Messaging protocol

Require a message envelope instead of raw strings or loose objects. The envelope should contain `type`, `version`, `requestId`, `source`, `target`, `createdAt`, and `payload`.

Validate incoming messages. Reject unknown `type`, unsupported `version`, missing `requestId`, unexpected `source`, and malformed `payload`.

Log sender identity. Use `sender.tab?.id`, `sender.frameId`, `sender.documentId`, `sender.origin`, `sender.url`, and `sender.documentLifecycle` when available.

Handle timeouts and disconnects. For ports, implement `onDisconnect` logging. For request/response messages, set bounded timeouts in callers and distinguish timeout from handler error.

For callback-style asynchronous `sendResponse`, keep the response channel open according to current Chrome messaging rules; the common Chrome pattern is to return literal `true` from the listener.

## Chrome API error handling

For callback-style Chrome APIs, inspect `chrome.runtime.lastError` inside the callback and convert it into a structured error or logged diagnostic.

For Promise-style Chrome APIs, wrap `await chrome.*` calls in `try/catch` at the boundary where the operation can be named and contextualized.

Do not suppress errors only because a tab closed, navigation changed, a frame disappeared, or the extension lacked host permission. Log those as expected failure categories with context.

## Content scripts and injected scripts

Treat isolated world content scripts and page MAIN world scripts as separate components. Log which world produced an event.

When injecting into MAIN world, validate the bridge. Check `origin`, frame, message shape, and expected nonce or request ID. Avoid trusting arbitrary `window.postMessage` payloads.

For all-frame content scripts, include `frameId`, `documentId`, and URL pattern in traces. Many bugs come from the correct script running in the wrong frame or a stale document.

Debug content scripts from the target page DevTools, not only from `chrome://extensions`. Select the extension execution context before evaluating variables.

## Permissions and network

For each feature, list required extension permissions and host permissions. During failures, record the requested API, the target host pattern, and the sanitized URL pattern.

Check optional permissions. Log whether permission was already granted, requested, denied, or removed.

For external `fetch`, confirm that the target host permission exists and that CORS, service worker lifecycle, and authentication state are handled separately in logs.

## declarativeNetRequest

Keep rules testable. For static rules, confirm invalid rules are caught in unpacked development builds. For dynamic/session rules, log rule IDs, priority, action type, and target condition summary.

In development builds, use DNR debug capabilities such as matched-rule inspection or hypothetical request testing where available. Do not depend on debug-only permissions or APIs in production behavior.

When a network rule appears to fail, distinguish “rule did not match,” “rule matched but lower priority lost,” “rule was invalid or disabled,” and “request came from an excluded tab/frame/resource type.”

## Source maps and build artifacts

Enable source maps for local and staging builds. Confirm DevTools resolves authored source paths and call stacks.

For production, decide whether source maps are omitted, uploaded to an internal error system, or distributed with the extension. Do not ship secrets, private endpoints, internal credentials, or sensitive test fixtures in bundled code or source maps.

## Production diagnostics

Prefer a bounded ring buffer in `chrome.storage.session` for local diagnostics export. Include recent structured trace events and safe stack hashes. Keep size limits explicit.

Gate remote telemetry behind user-visible disclosure and the project’s privacy policy. Collect the minimum fields needed to diagnose the user-facing feature.

Provide a user or developer action to export diagnostics when feasible. Include extension version, browser version if available, feature flags, and redacted trace events.

## Test matrix

Add tests for extension loading, popup-to-service-worker messaging, content-script-to-service-worker messaging, service worker restart, tab navigation, iframe or all-frame behavior, permission denial, DNR rule matching when relevant, and source map availability in development builds.

Use an end-to-end runner that loads the built extension. For MV3, include a test that terminates or restarts the service worker and repeats the action that previously depended on in-memory state.
