# Onboarding

The onboarding page is a first-run extension page opened after a fresh install. It teaches one action or setting per step, then writes completed setup choices through the shared `ExtensionStorage.settings` contract.

Keep steps narrow: page translation, Anki click behavior, known-word preset, gloss colors, AI key, AnkiConnect endpoint, and completion. Full settings remain in `src/options`.
