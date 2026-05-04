# Content Rendering Notes

The content script renders glosses in the page text flow. `createGlossOverlay` keeps the `#glossa-overlay` host for extension identity and settings variables, then wraps each rendered source word with an inline `data-glossa-token` span.

Each token wrapper keeps the original word on the page text baseline and positions the gloss label above it. The label and source word share the same vertical centerline. The wrapper reserves the wider of the label and source word, so dense labels create uneven word spacing through normal browser layout instead of covering neighboring labels or page text.

Rendering reconstructs each original text node once per response. Candidates in the same text node are applied from original offsets into one fragment so token offsets stay stable during the render pass. `clear()` unwraps rendered tokens back to plain text before the next scan.

Mutation handling treats render and cleanup DOM writes as owned mutations. External page mutations still invalidate the active scan version and clear rendered wrappers before rescanning.
