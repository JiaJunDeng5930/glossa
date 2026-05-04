---
name: chrome-extension-debugability
description: Improve, audit, and implement debugability for Chrome Extensions, especially Manifest V3. Use when modifying or reviewing extension code involving service workers, content scripts, popup/options/side panel/offscreen documents, message passing, Chrome API error handling, permissions or host permissions, declarativeNetRequest, source maps, diagnostics, logging, or end-to-end tests for extension lifecycle and debugging issues.
---

# Chrome Extension Debugability

## Goal

Make Chrome Extension failures diagnosable by execution context, tab, frame, document, message, request, rule, permission, and service worker lifecycle state. Prefer changes that let another engineer reproduce, inspect, and explain a bug with local DevTools, structured traces, and repeatable tests.

## Workflow

Start by opening `manifest.json` and mapping the extension components: `background.service_worker`, `content_scripts`, popup, options page, side panel, offscreen document, injected page scripts, and any `declarative_net_request` rules. Treat each component as a separate execution context with separate logs, errors, lifecycle, and DevTools entry point.

Run `scripts/audit_chrome_extension_debugability.py <extension-root>` when extension source is available. Use the output as a triage aid, then inspect the code directly before making claims. The script reports common red flags; it cannot prove correctness.

Read `references/debugability-checklist.md` for a full audit or bug triage pass. Read `references/implementation-patterns.md` when adding structured logging, message envelopes, service worker-safe state, diagnostics buffers, or lifecycle tests.

## Core implementation rules

Use structured logging instead of ad hoc console strings. Every trace-worthy event should include `component`, `extensionVersion`, `requestId`, `tabId`, `frameId`, `documentId`, `origin`, a sanitized URL or URL pattern, the operation name, and error details with `error.name`, `error.message`, and stack or stack hash when safe.

Treat MV3 service workers as ephemeral. Register event listeners synchronously at top level. Persist durable state in `chrome.storage.local` or another durable store. Use `chrome.storage.session` for in-session debug buffers. Use `chrome.alarms` for durable delayed work. Avoid relying on module-level mutable state, long-lived timers, `window`, `document`, or DOM access in the service worker.

Make message passing a protocol. Send envelopes with `type`, `version`, `requestId`, `source`, `target`, `createdAt`, and `payload`. Validate the envelope at each boundary. Log sender fields such as `sender.tab?.id`, `sender.frameId`, `sender.documentId`, `sender.origin`, `sender.url`, and `sender.documentLifecycle` where available. For asynchronous `sendResponse` flows, keep the channel open according to current Chrome messaging rules; for the common callback pattern, return literal `true` from the listener.

Handle Chrome API failures explicitly. For callback-style APIs, read `chrome.runtime.lastError` inside the callback. For Promise-style APIs, use `try/catch` or `.catch()`. Do not allow unchecked `runtime.lastError` warnings to be the only error signal.

Debug content scripts in the target page DevTools and select the extension execution context in Console/Sources. Keep the isolated world and page MAIN world separate in design and logs. When bridging to page scripts, validate origin, message shape, frame, and document identity.

Keep permission and network failures explainable. Log the feature, required permission, requested host pattern, target URL pattern after redaction, and the exact API error. For `declarativeNetRequest`, make static, dynamic, and session rules testable and record rule IDs that matched in development builds.

Use source maps deliberately. Enable source maps for local and staging builds. Treat production source maps as release artifacts with a controlled publication policy, because they expose source paths and source text.

Keep production diagnostics privacy-preserving. Store short ring buffers rather than unbounded logs. Redact query strings, tokens, cookies, email addresses, form values, DOM text, and page body. Gate remote upload behind user-visible disclosure and the project’s privacy policy.

Test lifecycle behavior. Add end-to-end tests that load the built extension, exercise popup/content/service worker flows, terminate or restart the service worker, and repeat the action. Include at least one negative-path test for missing permissions, tab/frame mismatch, message timeout, or DNR rule mismatch when relevant.

## Review output expectations

When auditing or modifying a Chrome Extension for debugability, return a concise report that names the affected component, the failure mode, the code path, and the recommended change. Include tests or manual DevTools steps that verify the change. Flag uncertainty clearly when a finding depends on Chrome version, extension build configuration, or runtime-only behavior.
