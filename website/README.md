# Glossa Website Notes

The landing page is a static Cloudflare Pages site served directly from `website/public`.

Desktop keeps one pinned stage: the left track moves through three text panels, and the right reading demo changes state through CSS variables written by `updateStory()` in `public/index.html`.

The right demo should mirror the extension content overlay. Gloss examples use inline `data-glossa-token` wrappers with the source word on the text baseline, a compact label above the word, hidden width reservation, and dotted underline styling. Keep this model aligned with `src/content/overlay.ts` when changing the demo.

Styles live in `public/styles/global.css`. Keep assets under `public/assets` so local file previews and Cloudflare Pages use the same paths.

Use existing raster assets or generated bitmap images for image moments. Do not introduce hand-drawn SVG illustration assets for this page.
