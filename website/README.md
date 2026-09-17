# Glossa Website Notes

The landing page is a static Cloudflare Pages site served from `website/public`. Keep the release CTA pointed at `releases/latest` and keep marketing copy independent from extension implementation details.

For implementation review, use `npm run preview:ui`. It builds the extension and serves the translation, settings, and popup pages from production bundles and styles. The translation preview entry calls the production content scanner and overlay; use that preview for overlay checks instead of maintaining a hand-copied sample or a second renderer.

Styles and marketing assets live under `website/public`. Reuse existing raster assets or generated bitmap images for image moments; do not add hand-drawn SVG illustration assets for this page.

Website coverage lives in `tests/e2e/website.spec.ts`. It runs with the normal Playwright command `npm run test:e2e` and is included in `npm run verify`; there is no separate landing-page test command.
