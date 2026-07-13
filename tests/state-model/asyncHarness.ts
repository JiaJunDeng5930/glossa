export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value?: T): void;
  reject(reason?: unknown): void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise(value as T);
    },
    reject: rejectPromise
  };
}

export interface TestEvent<TArgs extends unknown[]> {
  addListener(listener: (...args: TArgs) => void): void;
  emit(...args: TArgs): void;
}

export function createTestEvent<TArgs extends unknown[]>(): TestEvent<TArgs> {
  const listeners: Array<(...args: TArgs) => void> = [];
  return {
    addListener(listener) {
      listeners.push(listener);
    },
    emit(...args) {
      for (const listener of [...listeners]) {
        listener(...args);
      }
    }
  };
}

export async function drainMicrotasks(turns = 12): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await Promise.resolve();
  }
}

export async function waitForMicrotask(
  predicate: () => boolean,
  description: string,
  maxTurns = 100
): Promise<void> {
  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error(`Microtask condition was not reached: ${description}`);
}
