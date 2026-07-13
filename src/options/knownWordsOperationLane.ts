export interface KnownWordsOperationLane {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

export function createKnownWordsOperationLane(): KnownWordsOperationLane {
  return {
    run(operation) {
      return operation();
    }
  };
}
