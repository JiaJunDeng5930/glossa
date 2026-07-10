# Glossa Plugin Design

Glossa is a quiet reading instrument. Its interface borrows the landing page's editorial atmosphere without copying the landing page settings mockup.

## Visual language

- Warm paper (`#f2efe7`) is the canvas; light paper (`#faf8f1`) holds working surfaces.
- Ink (`#171814`) carries primary text; muted olive-gray carries secondary text.
- Vermillion (`#c84724`) marks the primary action, active navigation, and selected reading details.
- Serif type creates editorial hierarchy. Sans-serif type carries controls, metadata, and status.
- Fine rules organize information. Square, document-like surfaces replace decorative cards.
- Shadows only separate floating UI from a page: sticky headers, dialogs, and page overlays.

## Product surfaces

- Popup: one page state, one primary translation action, settings, and the saved shortcut.
- Options: a continuous settings document with a persistent index and numbered sections.
- Onboarding: an eight-step reading-room sequence with one lesson or decision per page.
- Page UI: compact inline glosses, a quiet selection cue, and a focused duplicate-card confirmation.

## Interaction details

- Focus remains visible with a warm ochre outline.
- Motion is short and functional, and follows `prefers-reduced-motion`.
- Success and error colors remain semantic accents instead of becoming large decorative fills.
- Responsive layouts preserve reading order and keep every control reachable from 320px upward.
