import { createDiagnosticError, diagnosticErrorFrom } from "./errors";
import { validateBackgroundResponse, type RequestMessage, type ResponseMessage } from "./messages";

export function sendRuntimeRequest<Q extends RequestMessage>(request: Q, options: { timeoutMs?: number | null } = {}): Promise<ResponseMessage<Q["type"]>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (action: () => void) => { if (settled) return; settled = true; clearTimeout(timer); action(); };
    const fail = (error: unknown) => finish(() => reject(diagnosticErrorFrom(error, { reason: "runtime", message: "Extension request failed", service: "runtime" })));
    if (!globalThis.chrome?.runtime?.sendMessage) { fail(new Error("Extension runtime is unavailable")); return; }
    const timeoutMs = options.timeoutMs === undefined ? 5000 : options.timeoutMs;
    if (timeoutMs !== null) timer = setTimeout(() => fail(createDiagnosticError("timeout", `Message timeout for ${request.type}`, { service: "runtime" })), timeoutMs);
    const acceptResponse = (raw: unknown) => {
      if (settled) return;
      try {
        const response = validateBackgroundResponse(raw, request);
        finish(() => resolve(response as ResponseMessage<Q["type"]>));
      } catch (error) { fail(error); }
    };
    try {
      // Chrome supports callbacks while Promise-only runtimes and test adapters may return a thenable.
      // A runtime that supplies both still owns only one response settlement.
      const returned: unknown = chrome.runtime.sendMessage(request, (raw: unknown) => {
        const error = chrome.runtime.lastError;
        if (error) { fail(new Error(error.message)); return; }
        acceptResponse(raw);
      });
      if (returned && (typeof returned === "object" || typeof returned === "function") && "then" in returned && typeof returned.then === "function") {
        Promise.resolve(returned).then(acceptResponse, fail);
      }
    } catch (error) { fail(error); }
  });
}
