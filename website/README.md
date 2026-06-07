# Glossa Website Notes

The landing page keeps the original sticky scroll model. Desktop uses one pinned stage: the left track moves through three text panels, and the right reading demo changes state through CSS variables written by `updateStory()` in `src/pages/index.astro`.

The right demo should mirror the extension content overlay. Gloss examples use inline `data-glossa-token` wrappers with the source word on the text baseline, a compact label above the word, hidden width reservation, and dotted underline styling. Keep this model aligned with `src/content/overlay.ts` when changing the demo.

Use existing raster assets or generated bitmap images for image moments. Do not introduce hand-drawn SVG illustration assets for this page.
