# Background entry points

`src/background/index.ts` registers the service-worker listeners. `glossPort.ts` owns the streaming gloss protocol, `glossResolver.ts` owns lookup and shared AI work, `messages.ts` handles runtime requests, and `settingsService.ts` / `vocabularyService.ts` keep worker-side mutations behind storage boundaries. `src/shared/services/aiClient.ts` and `src/shared/services/ankiClient.ts` are the external-service adapters.

Keep the following boundaries stable:

- A page occurrence, an AI frame request item, a shared gloss job, and an RPC request are separate identities. Jobs own shared generation/cache work; subscribers own page-local emission and write tracking.
- Generation replacement and cache clearing fence stale memory and persistence work. A late result may settle internally, but it must not repopulate an obsolete generation or a closed subscriber.
- A click creates one Anki card. `cardedWords` is the durable word-level history used for duplicate confirmation; learning state is stored separately. An uncertain Anki side effect is not retried automatically.
- Settings and vocabulary mutations are validated at their message boundary and committed by the worker. Frontend pages do not write worker-owned records directly.

The wire contract lives in `src/shared/messages.ts`; update the contract and its validators together. Keep user-facing text in `src/shared/userMessages.ts` and diagnostic facts in the background layer.

Use `npm run typecheck`, `npm run test`, and `npm run build` for focused checks. `npm run verify` is the complete local gate.
