# Onboarding

The onboarding page is a first-run extension page opened after a fresh install. It teaches one action or setting per step, then writes setup choices through the shared `ExtensionStorage.settings` contract.

Step order: word familiarity recognition, page translation, Anki click behavior, known-word preset, gloss appearance, AI service, AnkiConnect, and completion.

Form normalization, appearance preview, and connection checks come from `src/shared/settingsForm.ts`, matching the options page behavior.
