# Glossa Engineering Notes

Glossa is a Chrome Manifest V3 extension built with TypeScript, esbuild, native DOM, and Shadow DOM. It adds contextual Chinese glosses to unfamiliar English words and can create Anki cards through a background service worker.

## Start here

Use the source and its types as the current behavior contract. The root [README](README.md) covers installation, configuration, and the supported development commands. The module notes point to the relevant entry points and constraints:

- `src/content/index.ts` owns page-local scanning, occurrence mapping, overlay rendering, and selection mode.
- `src/background/index.ts` owns runtime messages, AI and Anki side effects, cache lookup, and vocabulary persistence.
- `src/shared/` contains the settings, RPC, diagnostics, and user-message boundaries shared by pages and the service worker.
- `src/core/` and `src/storage/db.ts` contain pure vocabulary/cache rules and storage transactions.
- `src/options/`, `src/onboarding/`, and `src/popup/` own their page interaction; their README files describe only page-specific constraints.

The reasons for the cross-module ownership choices are recorded in [ADR-0001](docs/adr/0001-async-ownership-and-contracts.md). `docs/async-state-model.md` is a short design note, and `docs/ux-audit.md` is a historical product audit. Neither is an implementation inventory.

## Non-obvious engineering constraints

- Settings pages submit typed field patches. The worker reads the latest saved settings before applying a patch, so an entire stale form must not overwrite fields the user did not edit.
- A page occurrence, an AI frame request item, a shared gloss job, and an RPC request have different identities. Keep their mapping explicit at the boundary that owns each identity.
- Shared gloss jobs own generation/cache work; subscribers own page-local emission and feedback. Generation changes and cache clears must fence stale results from memory and persistent writes.
- One click represents one Anki card. `cardedWords` is the durable word-level card-history fact; vocabulary learning state and external note IDs have separate meanings. An uncertain Anki side effect is not automatically retried.
- UI operation state is local to the initiating control. A late connection, catalog, or vocabulary completion cannot replace newer input or unlock an unrelated operation.
- Background code reports diagnostic facts. Page UIs translate those facts through `src/shared/userMessages.ts`; do not make transport text the product contract.
- Keep the warm editorial visual language in `DESIGN.md`. The UI preview should exercise production rendering code instead of becoming a second overlay implementation.

## Commands

- `npm run typecheck`: TypeScript checks for production and test contracts.
- `npm run wordlists:check`: validate the checked-in known-word-list assets.
- `npm run test`: Vitest unit and integration tests.
- `npm run build`: build the extension and validate its generated artifacts.
- `npm run test:e2e`: Playwright browser checks against the built extension.
- `npm run preview:ui`: build the extension and serve the production-backed UI preview.
- `npm run verify`: run the local verification gate.

For extension debugability work, use `.skills/chrome-extension-debugability/scripts/audit_chrome_extension_debugability.py` on the source tree and, after a build, on `dist/`. The service worker is a generated artifact, so inspect `src/background/index.ts` together with `dist/background.js`.

## Documentation rule

Keep documentation focused on user behavior, entry points, development commands, and reasons that cannot be read directly from the code. Do not copy state tables, interface signatures, directory inventories, or test matrices into multiple documents. When a contract changes, update the source and its tests first, then adjust the smallest relevant note.
