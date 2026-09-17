import { diagnosticPayloadFrom } from "./errors";
import type { ErrorPayload } from "./types";

/**
 * State owned by one asynchronous UI operation.  The page only renders this
 * value; it never keeps a second pending/verified boolean for the same work.
 */
export type OperationState<T> =
  | { phase: "idle" }
  | { phase: "pending"; key: string }
  | { phase: "success"; key: string; value: T }
  | { phase: "error"; key: string; error: ErrorPayload };

export type OperationToken = object;
type OperationSubscriber<T> = (state: OperationState<T>, token: OperationToken | undefined) => void;

export interface FeedbackChannel {
  claim(token: OperationToken): void;
  claimExternal(): OperationToken;
  owns(token: OperationToken | undefined): boolean;
}

export interface OperationController<S, T> {
  readonly state: OperationState<T>;
  updateSettings(settings: S): void;
  invalidate(): void;
  start(): void;
  dispose(): void;
  subscribe(listener: (state: OperationState<T>, token: OperationToken | undefined) => void): () => void;
}

export interface ConnectionController<S> extends OperationController<S, void> {
  test(): void;
}

export interface AnkiCatalogController<S, T> extends OperationController<S, T> {
  refresh(): void;
}

export interface OperationControllerOptions<S, T> {
  identity(settings: S): string;
  run(settings: S, signal: AbortSignal): Promise<T>;
  errorFallback?: {
    reason: ErrorPayload["reason"];
    message: string;
    service?: NonNullable<ErrorPayload["service"]>;
  };
}

export function createFeedbackChannel(): FeedbackChannel {
  let currentToken: OperationToken | undefined;
  return {
    claim(token): void {
      currentToken = token;
    },
    claimExternal(): OperationToken {
      currentToken = {};
      return currentToken;
    },
    owns(token): boolean {
      return currentToken === token;
    }
  };
}

export function claimFeedback<T>(channel: FeedbackChannel, state: OperationState<T>, token: OperationToken | undefined): boolean {
  if (state.phase === "pending" && token) {
    channel.claim(token);
  }
  return channel.owns(token);
}

/**
 * Create the common latest-request lifecycle used by connection probes and
 * catalog reads.  A request object, rather than a key, is the authority for
 * accepting a completion: two retries with the same settings are still two
 * different requests.
 */
export function createOperationController<S, T>(
  options: OperationControllerOptions<S, T>,
  initialSettings: S
): OperationController<S, T> {
  let settings = initialSettings;
  let currentState: OperationState<T> = { phase: "idle" };
  let request: { token: OperationToken; key: string; abort: AbortController } | undefined;
  let stateToken: OperationToken | undefined;
  let disposed = false;
  const subscribers = new Set<OperationSubscriber<T>>();

  const notify = (): void => {
    for (const subscriber of subscribers) {
      subscriber(currentState, stateToken);
    }
  };

  const invalidate = (): void => {
    const token = request?.token ?? stateToken;
    request?.abort.abort();
    request = undefined;
    if (currentState.phase !== "idle") {
      currentState = { phase: "idle" };
      stateToken = token;
      notify();
    }
  };

  const start = (): void => {
    if (disposed || currentState.phase === "pending") {
      return;
    }
    const key = options.identity(settings);
    const controller = new AbortController();
    const token = {};
    request = { token, key, abort: controller };
    currentState = { phase: "pending", key };
    stateToken = token;
    notify();

    Promise.resolve()
      .then(() => options.run(settings, controller.signal))
      .then((value) => {
        if (disposed || request?.token !== token) {
          return;
        }
        request = undefined;
        currentState = { phase: "success", key, value };
        stateToken = token;
        notify();
      }, (error: unknown) => {
        if (disposed || request?.token !== token) {
          return;
        }
        request = undefined;
        currentState = {
          phase: "error",
          key,
          error: diagnosticPayloadFrom(error, options.errorFallback ?? {
            reason: "service-error",
            message: "UI operation failed"
          })
        };
        stateToken = token;
        notify();
      });
  };

  return {
    get state(): OperationState<T> {
      return currentState;
    },
    updateSettings(nextSettings: S): void {
      if (disposed) {
        return;
      }
      const previousKey = options.identity(settings);
      settings = nextSettings;
      if (previousKey !== options.identity(nextSettings)) {
        invalidate();
      }
    },
    invalidate,
    start,
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      request?.abort.abort();
      request = undefined;
      subscribers.clear();
    },
    subscribe(listener): () => void {
      if (disposed) {
        return () => undefined;
      }
      subscribers.add(listener);
      listener(currentState, stateToken);
      return () => subscribers.delete(listener);
    }
  };
}

export function createConnectionController<S>(
  options: OperationControllerOptions<S, void>,
  initialSettings: S
): ConnectionController<S> {
  const controller = createOperationController(options, initialSettings);
  return {
    get state(): OperationState<void> {
      return controller.state;
    },
    updateSettings: controller.updateSettings,
    invalidate: controller.invalidate,
    test: controller.start,
    start: controller.start,
    dispose: controller.dispose,
    subscribe: controller.subscribe
  };
}

export function createAnkiCatalogController<S, T>(
  options: OperationControllerOptions<S, T>,
  initialSettings: S
): AnkiCatalogController<S, T> {
  const controller = createOperationController(options, initialSettings);
  return {
    get state(): OperationState<T> {
      return controller.state;
    },
    updateSettings: controller.updateSettings,
    invalidate: controller.invalidate,
    refresh: controller.start,
    start: controller.start,
    dispose: controller.dispose,
    subscribe: controller.subscribe
  };
}
