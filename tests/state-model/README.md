# State-model tests

`tests/state-model` runs the production coordinators under Vitest. The tests observe protocol messages, DOM state, storage records, and external-call order; they do not parse a design document or implement a second state machine.

Run the focused suite with:

```text
npm run test:state-model
```

The same tests are included in `npm run test` and `npm run verify`. Use deferred promises and explicit release points for asynchronous ordering. Assertions should target observable behavior and side effects, while type contracts and owner boundaries remain enforced by the production modules.

The ownership rationale is recorded in [ADR-0001](../../docs/adr/0001-async-ownership-and-contracts.md). `docs/async-state-model.md` is background context only; changing it must not be required to make a test pass.
