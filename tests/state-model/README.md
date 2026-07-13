# Runtime state-machine tests

These tests evaluate Glossa's production coordinators. They do not parse or validate `docs/async-state-model.md`; the document supplies the expected behavior, while the tests drive real code and observe messages, DOM state, storage records, and external-call order.

Run the focused suite with:

```text
npm run test:state-model
```

The state-model files are also ordinary Vitest tests, so `npm test` and `npm run verify` include them. While the runtime migration is incomplete, failures are intentional evidence of implementation gaps and must not be converted to skipped, todo, or expected-failure tests.

The harness follows three rules:

- Asynchronous order is controlled with deferred promises and explicit release points, never timing collisions.
- Assertions target observable state and effects: port-message order, effect-call count, persistent records, response diagnostics, and rendered DOM state.
- A production closure may be extracted into a small injectable coordinator for testability, but the extraction must preserve runtime semantics; tests must still execute the same coordinator used by the extension entry point.

Coverage is split by owner boundary:

- `glossPort.test.ts`: port command serialization, protocol identity/order, ACK/done ordering, and disconnect closure.
- `generationCache.test.ts`: generation retirement and the manual-clear barrier against stale reads and writes.
- `vocabularyCard.test.ts`: vocabulary interleavings, card cardinality and external-commit semantics, duplicate suppression, and reset barriers.
- `contentUi.test.ts`: occurrence feedback priority, shortcut coordination, latest-result UI tasks, and popup live-state toggling.
- `knownWordsLane.test.ts`: FIFO admission for refresh/add/remove/clear and final-view consistency.
- Playwright scenarios cover browser-only owners such as overlapping content scans, settings document loading, Anki catalog revisions, and shortcut capture.
