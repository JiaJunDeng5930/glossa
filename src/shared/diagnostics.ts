// @constraint glossa.shared.diagnostics The diagnostics module emits structured trace events with sanitized tab and URL context.
import { isErrorPayload } from "./errors";

export type TraceComponent = "service-worker" | "content-script" | "options";
export type TraceResult = "ok" | "error" | "timeout" | "ignored";

export interface TraceEvent {
  component: TraceComponent;
  operation: string;
  result: TraceResult;
  requestId?: string | undefined;
  tabId?: number | undefined;
  frameId?: number | undefined;
  documentId?: string | undefined;
  origin?: string | undefined;
  url?: string | undefined;
  error?: unknown;
  details?: Record<string, string | number | boolean | undefined>;
}

export interface SafeTraceEvent {
  ts: string;
  extensionVersion: string;
  component: TraceComponent;
  operation: string;
  result: TraceResult;
  requestId?: string;
  tabId?: number;
  frameId?: number;
  documentId?: string;
  origin?: string;
  url?: string;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
  details?: Record<string, string | number | boolean | undefined>;
}

const TRACE_PREFIX = "[glossa-trace]";
const FALLBACK_VERSION = "dev";

export function trace(event: TraceEvent): SafeTraceEvent {
  const safeEvent = sanitizeTraceEvent(event);
  if (event.result === "error" || event.result === "timeout") {
    console.warn(TRACE_PREFIX, safeEvent);
  } else {
    console.debug(TRACE_PREFIX, safeEvent);
  }
  return safeEvent;
}

export function sanitizeTraceEvent(event: TraceEvent): SafeTraceEvent {
  const url = event.url ? sanitizeUrl(event.url) : undefined;
  const error = event.error === undefined ? undefined : sanitizeError(event.error);
  return {
    ts: new Date().toISOString(),
    extensionVersion: extensionVersion(),
    component: event.component,
    operation: event.operation,
    result: event.result,
    ...(event.requestId ? { requestId: event.requestId } : {}),
    ...(event.tabId === undefined ? {} : { tabId: event.tabId }),
    ...(event.frameId === undefined ? {} : { frameId: event.frameId }),
    ...(event.documentId ? { documentId: event.documentId } : {}),
    ...(event.origin ? { origin: event.origin } : {}),
    ...(url ? { url } : {}),
    ...(error ? { error } : {}),
    ...(event.details ? { details: event.details } : {})
  };
}

export function sanitizeUrl(input: string): string | undefined {
  try {
    const url = new URL(input);
    return `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
}

export function sanitizeError(error: unknown): SafeTraceEvent["error"] {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {})
    };
  }
  if (isErrorPayload(error)) {
    return {
      name: error.service ? `${error.service}:${error.reason}` : error.reason,
      message: error.message
    };
  }
  return {
    name: "Error",
    message: String(error)
  };
}

function extensionVersion(): string {
  try {
    return globalThis.chrome?.runtime?.getManifest?.().version ?? FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}
