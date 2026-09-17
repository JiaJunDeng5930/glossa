# Content entry points

`src/content/index.ts` coordinates the page runtime. `scanner.ts`, `context.ts`, and `range.ts` find readable source ranges; `occurrence.ts` keeps source locations and occurrence identity; `overlay.ts` renders glosses and feedback; `selection.ts` handles the hold-and-click gesture.

The page runtime owns DOM state locally. Keep these constraints when changing it:

- An occurrence is a page location with a request snapshot. It is distinct from an AI frame request item and from the token identity used on the wire.
- The current DOM source remains the authority for unwrapping and sentence context. Generated labels and feedback must not leak into the host page's source text.
- Disable and route changes close page-local gloss sessions and remove rendered wrappers. Ordinary DOM changes may reconcile pending results only after the stored occurrence snapshot still matches.
- Card feedback belongs to the occurrence that was clicked and may outlive a scan refresh; a late response must not attach to a different source location.

The background protocol is defined in `src/shared/messages.ts`; keep content-side rendering decisions separate from transport diagnostics. Use `npm run typecheck`, `npm run test`, and the relevant `npm run test:e2e` scenarios when changing page behavior.
