// @behavior glossa.failure_reporting Provider, request, and runtime failures become diagnostic payloads with stable reasons.
import type { ErrorPayload, ErrorReason, ErrorService } from "./types";

export class GlossaDiagnosticError extends Error {
  readonly payload: ErrorPayload;
  readonly cause?: unknown;

  constructor(payload: ErrorPayload, cause?: unknown) {
    super(payload.message);
    this.name = "GlossaDiagnosticError";
    this.payload = payload;
    this.cause = cause;
  }
}

export function createErrorPayload(
  reason: ErrorReason,
  message: string,
  options: { service?: ErrorService; status?: number } = {}
): ErrorPayload {
  return {
    reason,
    message,
    ...(options.service ? { service: options.service } : {}),
    ...(options.status === undefined ? {} : { status: options.status })
  };
}

export function createDiagnosticError(
  reason: ErrorReason,
  message: string,
  options: { service?: ErrorService; status?: number; cause?: unknown } = {}
): GlossaDiagnosticError {
  return new GlossaDiagnosticError(createErrorPayload(reason, message, options), options.cause);
}

export function errorPayloadFromHttpStatus(service: ErrorService, status: number): ErrorPayload {
  if (status === 401 || status === 403) {
    return createErrorPayload("unauthorized", `${service} HTTP ${status}`, { service, status });
  }
  if (status === 404) {
    return createErrorPayload("not-found", `${service} HTTP ${status}`, { service, status });
  }
  return createErrorPayload("service-error", `${service} HTTP ${status}`, { service, status });
}

export function diagnosticPayloadFrom(
  error: unknown,
  fallback: { reason: ErrorReason; message: string; service?: ErrorService }
): ErrorPayload {
  if (error instanceof GlossaDiagnosticError) {
    return error.payload;
  }
  return createErrorPayload(fallback.reason, errorMessage(error, fallback.message), fallbackOptions(fallback.service));
}

export function requestDiagnosticErrorFrom(
  error: unknown,
  fallback: { reason: ErrorReason; message: string; service?: ErrorService }
): GlossaDiagnosticError {
  if (error instanceof GlossaDiagnosticError) {
    return error;
  }
  if (isAbortError(error)) {
    return new GlossaDiagnosticError(createErrorPayload("timeout", errorMessage(error, fallback.message), fallbackOptions(fallback.service)), error);
  }
  if (error instanceof TypeError) {
    return new GlossaDiagnosticError(createErrorPayload("network", error.message || fallback.message, fallbackOptions(fallback.service)), error);
  }
  if (error instanceof SyntaxError) {
    return new GlossaDiagnosticError(createErrorPayload("invalid-response", error.message || fallback.message, fallbackOptions(fallback.service)), error);
  }
  return new GlossaDiagnosticError(createErrorPayload(fallback.reason, errorMessage(error, fallback.message), fallbackOptions(fallback.service)), error);
}

export function diagnosticErrorFrom(
  error: unknown,
  fallback: { reason: ErrorReason; message: string; service?: ErrorService }
): GlossaDiagnosticError {
  if (error instanceof GlossaDiagnosticError) {
    return error;
  }
  return new GlossaDiagnosticError(diagnosticPayloadFrom(error, fallback), error);
}

export function isErrorPayload(value: unknown): value is ErrorPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const payload = value as Record<string, unknown>;
  return isErrorReason(payload.reason)
    && typeof payload.message === "string"
    && (payload.service === undefined || isErrorService(payload.service))
    && (payload.status === undefined || typeof payload.status === "number");
}

export function isErrorReason(value: unknown): value is ErrorReason {
  return value === "network"
    || value === "timeout"
    || value === "unauthorized"
    || value === "not-found"
    || value === "service-error"
    || value === "invalid-response"
    || value === "runtime";
}

function isErrorService(value: unknown): value is ErrorService {
  return value === "ai" || value === "anki" || value === "runtime";
}

function fallbackOptions(service: ErrorService | undefined): { service?: ErrorService } {
  return service ? { service } : {};
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
    || typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string" && error) {
    return error;
  }
  return fallback;
}
