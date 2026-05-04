#!/usr/bin/env python3
"""Static debugability audit for Chrome Extension projects.

The script reports common Manifest V3, logging, messaging, permission, DNR,
and testability red flags. It is intentionally conservative: findings are
triage prompts, not proofs of incorrectness.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Iterable, List, Optional

SKIP_DIRS = {
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "coverage",
    ".nyc_output",
    ".cache",
    ".parcel-cache",
    ".turbo",
    ".next",
}
CODE_SUFFIXES = {".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"}
MAX_FILE_BYTES = 2_000_000


@dataclass
class Finding:
    severity: str
    area: str
    message: str
    file: Optional[str] = None
    evidence: Optional[str] = None
    recommendation: Optional[str] = None


def read_text(path: Path) -> str:
    try:
        if path.stat().st_size > MAX_FILE_BYTES:
            return ""
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def rel(path: Path, root: Path) -> str:
    try:
        return str(path.relative_to(root))
    except ValueError:
        return str(path)


def iter_code_files(root: Path) -> Iterable[Path]:
    for current_root, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith("__")]
        for filename in files:
            path = Path(current_root) / filename
            if path.suffix.lower() in CODE_SUFFIXES:
                yield path


def find_manifest(root: Path) -> Path:
    manifest = root / "manifest.json"
    if manifest.exists():
        return manifest
    candidates = list(root.glob("**/manifest.json"))
    if len(candidates) == 1:
        return candidates[0]
    if not candidates:
        raise FileNotFoundError("No manifest.json found")
    raise FileNotFoundError("Multiple manifest.json files found; pass the extension build root")


def json_load(path: Path) -> dict:
    try:
        return json.loads(read_text(path))
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid JSON in {path}: {exc}") from exc


def regex_count(pattern: str, text: str, flags: int = 0) -> int:
    return len(re.findall(pattern, text, flags))


def collect_code(root: Path) -> tuple[list[Path], str]:
    files = list(iter_code_files(root))
    combined = "\n".join(read_text(path) for path in files)
    return files, combined


def audit_manifest(root: Path, manifest_path: Path, manifest: dict) -> list[Finding]:
    findings: list[Finding] = []
    manifest_rel = rel(manifest_path, root)
    mv = manifest.get("manifest_version")
    permissions = set(manifest.get("permissions") or [])
    host_permissions = manifest.get("host_permissions") or []

    if mv == 3:
        findings.append(Finding("PASS", "manifest", "Manifest V3 detected.", manifest_rel))
        bg = manifest.get("background") or {}
        if bg.get("service_worker"):
            findings.append(Finding("PASS", "service-worker", "background.service_worker is declared.", manifest_rel, bg.get("service_worker")))
        else:
            findings.append(Finding("HIGH", "service-worker", "Manifest V3 extension has no background.service_worker declared.", manifest_rel, recommendation="Confirm whether all background behavior is event-free; otherwise declare and instrument a service worker."))
    elif mv == 2:
        findings.append(Finding("WARN", "manifest", "Manifest V2 detected.", manifest_rel, recommendation="For current Chrome Extension work, confirm MV2 support and migration status before applying MV3-specific guidance."))
    else:
        findings.append(Finding("WARN", "manifest", "manifest_version is missing or unexpected.", manifest_rel, evidence=str(mv)))

    if not permissions:
        findings.append(Finding("INFO", "permissions", "No extension permissions declared.", manifest_rel))
    if not host_permissions and not manifest.get("content_scripts"):
        findings.append(Finding("INFO", "permissions", "No host_permissions or content_scripts.matches declared.", manifest_rel, recommendation="If the extension accesses pages or external hosts, make host requirements explicit and log permission failures."))

    if "debugger" in permissions:
        findings.append(Finding("HIGH", "permissions", "The debugger permission is declared.", manifest_rel, recommendation="Keep chrome.debugger capabilities development-only or tightly gated; it changes lifecycle behavior and has broad inspection power."))

    dnr_perms = {"declarativeNetRequest", "declarativeNetRequestWithHostAccess", "declarativeNetRequestFeedback"}
    if permissions & dnr_perms:
        findings.append(Finding("INFO", "declarativeNetRequest", "DNR-related permission declared.", manifest_rel, evidence=", ".join(sorted(permissions & dnr_perms)), recommendation="Ensure rules have development-time match diagnostics and rule ID logging."))
        if "declarativeNetRequestFeedback" in permissions:
            findings.append(Finding("WARN", "declarativeNetRequest", "declarativeNetRequestFeedback is present.", manifest_rel, recommendation="Confirm this permission is used only where appropriate for unpacked/development diagnostics."))

    content_scripts = manifest.get("content_scripts") or []
    if content_scripts:
        all_frames_count = sum(1 for cs in content_scripts if cs.get("all_frames"))
        findings.append(Finding("INFO", "content-scripts", f"{len(content_scripts)} content script declaration(s) found; {all_frames_count} use all_frames.", manifest_rel, recommendation="Log tabId, frameId, documentId, origin, and sanitized URL for content-script events."))

    if manifest.get("options_page") or manifest.get("options_ui"):
        findings.append(Finding("INFO", "ui-contexts", "Options UI declared.", manifest_rel))
    if manifest.get("action", {}).get("default_popup") or manifest.get("browser_action", {}).get("default_popup"):
        findings.append(Finding("INFO", "ui-contexts", "Popup UI declared.", manifest_rel))
    if manifest.get("side_panel"):
        findings.append(Finding("INFO", "ui-contexts", "Side panel declared.", manifest_rel))

    return findings


def audit_service_worker(root: Path, manifest_path: Path, manifest: dict) -> list[Finding]:
    findings: list[Finding] = []
    if manifest.get("manifest_version") != 3:
        return findings
    service_worker = (manifest.get("background") or {}).get("service_worker")
    if not service_worker:
        return findings

    sw_path = (manifest_path.parent / service_worker).resolve()
    sw_rel = rel(sw_path, root)
    text = read_text(sw_path)
    if not text:
        findings.append(Finding("WARN", "service-worker", "Service worker file could not be read or is empty.", sw_rel))
        return findings

    top_level_mutables = regex_count(r"(?m)^\s*(?:let|var)\s+[A-Za-z_$][\w$]*", text)
    if top_level_mutables:
        findings.append(Finding("WARN", "service-worker", "Module-level mutable declarations found in service worker.", sw_rel, evidence=str(top_level_mutables), recommendation="Confirm durable state is persisted; do not rely on globals surviving termination."))

    if re.search(r"chrome\.runtime\.onMessage\.addListener\s*\(\s*async\b", text):
        findings.append(Finding("WARN", "messaging", "onMessage listener is declared async.", sw_rel, recommendation="If using sendResponse, avoid implicit Promise confusion and keep the channel open according to current Chrome messaging rules."))

    if "chrome.runtime.onMessage.addListener" in text and "return true" not in text:
        findings.append(Finding("WARN", "messaging", "onMessage listener found without an obvious `return true`.", sw_rel, recommendation="For async sendResponse callback flows, return literal true from the listener."))

    if re.search(r"\b(setTimeout|setInterval)\s*\(", text):
        findings.append(Finding("WARN", "service-worker", "Timer usage found in service worker.", sw_rel, recommendation="Use chrome.alarms for durable delayed work; verify losing the timer during termination is harmless."))

    if re.search(r"\b(window|document|localStorage)\b", text):
        findings.append(Finding("HIGH", "service-worker", "Browser global or DOM-like API reference found in service worker.", sw_rel, recommendation="Service workers should avoid window/document/localStorage; use chrome.storage or an offscreen document when DOM access is required."))

    if "chrome.storage" not in text:
        findings.append(Finding("INFO", "service-worker", "No chrome.storage usage found in service worker.", sw_rel, recommendation="If the worker has durable state, store it outside module globals."))

    return findings


def audit_codebase(root: Path, manifest: dict) -> list[Finding]:
    findings: list[Finding] = []
    files, combined = collect_code(root)
    file_count = len(files)
    findings.append(Finding("INFO", "codebase", f"Scanned {file_count} JavaScript/TypeScript file(s)."))

    has_messages = any(token in combined for token in ["sendMessage", ".connect(", "onMessage.addListener", "onConnect.addListener"])
    if has_messages:
        if "requestId" not in combined:
            findings.append(Finding("WARN", "messaging", "Messaging APIs found but no `requestId` string appears in scanned code.", recommendation="Use message envelopes with requestId to correlate popup/content/service-worker hops."))
        if not re.search(r"\b(type|kind)\b", combined):
            findings.append(Finding("WARN", "messaging", "Messaging APIs found without an obvious message type discriminator.", recommendation="Use a stable `type` field and validate it at every boundary."))
    else:
        findings.append(Finding("INFO", "messaging", "No obvious extension messaging API usage found."))

    if "chrome.runtime.lastError" not in combined and re.search(r"chrome\.[\w.]+\([^;]*=>|chrome\.[\w.]+\([^;]*function\s*\(", combined, re.S):
        findings.append(Finding("WARN", "chrome-api-errors", "Callback-style Chrome API usage found but no chrome.runtime.lastError reference appears in scanned code.", recommendation="Read runtime.lastError inside callbacks and convert it to structured diagnostics."))

    console_count = regex_count(r"\bconsole\.(log|debug|info|warn|error)\s*\(", combined)
    if console_count:
        missing_fields = [field for field in ["component", "requestId", "tabId", "frameId", "documentId", "operation"] if field not in combined]
        if missing_fields:
            findings.append(Finding("WARN", "logging", "Console logging exists but common structured trace fields are missing from scanned code.", evidence=", ".join(missing_fields), recommendation="Adopt a trace helper and include execution context identifiers."))
        else:
            findings.append(Finding("PASS", "logging", "Console logging and common structured trace field names found."))
    else:
        findings.append(Finding("WARN", "logging", "No console logging found in scanned code.", recommendation="Add structured traces at extension boundaries and error paths."))

    if re.search(r"\b(tab\.url|sender\.url|location\.href|document\.URL)\b", combined) and console_count:
        findings.append(Finding("WARN", "privacy", "URL values appear near code that may log diagnostics.", recommendation="Sanitize URLs before logging; remove query strings, fragments, tokens, and user identifiers."))

    if any(".map" == path.suffix.lower() for path in root.glob("**/*")):
        findings.append(Finding("INFO", "source-maps", "Source map files found.", recommendation="Confirm source maps are intended for this build and do not expose secrets or private fixtures."))
    else:
        findings.append(Finding("INFO", "source-maps", "No source map files found.", recommendation="Enable source maps for local/staging debugging or store production maps as controlled release artifacts."))

    permissions = set(manifest.get("permissions") or [])
    if permissions & {"declarativeNetRequest", "declarativeNetRequestWithHostAccess", "declarativeNetRequestFeedback"}:
        if not re.search(r"(onRuleMatchedDebug|getMatchedRules|testMatchOutcome)", combined):
            findings.append(Finding("WARN", "declarativeNetRequest", "DNR permissions found but no obvious DNR debug/test API usage appears in scanned code.", recommendation="Add development-only rule match inspection or testMatchOutcome coverage when relevant."))

    package_json = root / "package.json"
    package_text = read_text(package_json) if package_json.exists() else ""
    has_e2e = re.search(r"(puppeteer|playwright|selenium|webdriverio|wdio)", package_text, re.I) or re.search(r"(puppeteer|playwright|selenium|webdriverio|wdio)", combined, re.I)
    if has_e2e:
        findings.append(Finding("PASS", "testing", "Browser automation dependency or usage found."))
        if not re.search(r"(service\s*worker|serviceworker|terminate|restart)", combined, re.I):
            findings.append(Finding("WARN", "testing", "No obvious service worker termination/restart test text found.", recommendation="Add an E2E test that repeats a flow after MV3 service worker termination."))
    else:
        findings.append(Finding("WARN", "testing", "No obvious browser automation test dependency or usage found.", recommendation="Add E2E tests that load the built extension and exercise popup/content/service-worker flows."))

    return findings


def render_markdown(findings: list[Finding], root: Path) -> str:
    order = {"HIGH": 0, "WARN": 1, "INFO": 2, "PASS": 3}
    sorted_findings = sorted(findings, key=lambda item: (order.get(item.severity, 9), item.area, item.file or ""))
    lines = [f"# Chrome Extension Debugability Audit", "", f"Root: `{root}`", ""]
    for severity in ["HIGH", "WARN", "INFO", "PASS"]:
        items = [item for item in sorted_findings if item.severity == severity]
        if not items:
            continue
        lines.append(f"## {severity}")
        lines.append("")
        for item in items:
            location = f" ({item.file})" if item.file else ""
            lines.append(f"- **{item.area}**{location}: {item.message}")
            if item.evidence:
                lines.append(f"  - Evidence: `{item.evidence}`")
            if item.recommendation:
                lines.append(f"  - Recommendation: {item.recommendation}")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Audit Chrome Extension debugability red flags.")
    parser.add_argument("extension_root", type=Path, help="Path to an unpacked extension or extension project root")
    parser.add_argument("--format", choices=["markdown", "json"], default="markdown", help="Output format")
    args = parser.parse_args(argv)

    root = args.extension_root.resolve()
    if not root.exists():
        print(f"Path does not exist: {root}", file=sys.stderr)
        return 2

    try:
        manifest_path = find_manifest(root)
        manifest = json_load(manifest_path)
        findings = []
        findings.extend(audit_manifest(root, manifest_path, manifest))
        findings.extend(audit_service_worker(root, manifest_path, manifest))
        findings.extend(audit_codebase(root, manifest))
    except (FileNotFoundError, ValueError) as exc:
        findings = [Finding("HIGH", "setup", str(exc), recommendation="Pass the built extension root that contains exactly one manifest.json.")]

    if args.format == "json":
        print(json.dumps([asdict(item) for item in findings], indent=2, ensure_ascii=False))
    else:
        print(render_markdown(findings, root))

    return 1 if any(item.severity == "HIGH" for item in findings) else 0


if __name__ == "__main__":
    raise SystemExit(main())
