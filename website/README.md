# Glossa Website Notes

The landing page is a static Cloudflare Pages site served directly from `website/public`.

The page uses an editorial reading-room visual system: warm paper, ink typography, vermilion annotations, and product UI rendered with HTML and CSS. Keep the release CTA pointed at `releases/latest`.

Desktop uses one pinned reading stage. Three copy chapters crossfade in place while the article reveals glosses, the Alt-click gesture, and the Anki card through CSS variables written by the inline story controller. Mobile and reduced-motion modes keep every chapter and the completed demo in normal document flow.

Reading demos should mirror the extension content overlay. Gloss examples keep inline `data-glossa-token` wrappers with the source word on the text baseline and a compact label above it. Keep this model aligned with `src/content/overlay.ts` when changing the demo.

Styles live in `public/styles/global.css`. Keep assets under `public/assets` so local file previews and Cloudflare Pages use the same paths.

Use existing raster assets or generated bitmap images for image moments. Do not introduce hand-drawn SVG illustration assets for this page.

Run `node --test website/landing.test.mjs` from the repository root for the landing-page smoke check.
