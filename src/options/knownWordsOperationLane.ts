export interface KnownWordsOperationLane {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

export function createKnownWordsOperationLane(): KnownWordsOperationLane {
  let tail: Promise<void> | undefined;
  return {
    run(operation) {
      const current = tail ? tail.then(operation) : operation();
      const settled = current.then(() => undefined, () => undefined);
      tail = settled;
      void settled.then(() => {
        if (tail === settled) {
          tail = undefined;
        }
      });
      return current;
    }
  };
}
