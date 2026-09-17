# Onboarding

`src/onboarding/onboarding.ts` is the first-run page entry point. It teaches the minimum setup needed to use Glossa and persists each completed choice through the shared settings RPC.

The page uses the same form normalization and connection-operation boundaries as the options page. AI verification is required before onboarding completes; Anki remains an optional step. Step identity and navigation rules live in the page source so this note does not duplicate the flow table.

Use `npm run typecheck` and the onboarding Playwright scenario when changing this page.
