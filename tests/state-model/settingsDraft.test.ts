import { describe, expect, it } from "vitest";

import { createSettingsDraft } from "../../src/shared/settingsDraft";
import { DEFAULT_SETTINGS, type GlossaSettings } from "../../src/shared/types";
import { deferred, drainMicrotasks } from "./asyncHarness";

function settings(overrides: Partial<GlossaSettings> = {}): GlossaSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...overrides,
    appearance: { ...DEFAULT_SETTINGS.appearance, ...overrides.appearance },
    prompts: { ...DEFAULT_SETTINGS.prompts, ...overrides.prompts },
    ai: { ...DEFAULT_SETTINGS.ai, ...overrides.ai },
    anki: { ...DEFAULT_SETTINGS.anki, ...overrides.anki }
  };
}

describe("settings draft", () => {
  it("saves disjoint fields as a patch and preserves untouched fields", async () => {
    const patches: unknown[] = [];
    const draft = createSettingsDraft({
      initial: settings({ promptVersion: "future" }),
      persist: async (patch) => {
        patches.push(patch);
        return settings({ promptVersion: "future", shortcutKey: "Ctrl+K", knownWordList: "toefl" });
      }
    });
    draft.edit({ shortcutKey: "Ctrl+K" });
    await draft.save(["shortcutKey"]);
    expect(patches).toEqual([{ shortcutKey: "Ctrl+K" }]);
    expect(draft.base.promptVersion).toBe("future");
    expect(draft.value.knownWordList).toBe("toefl");
    expect(draft.dirty).toBe(false);
  });

  it("does not overwrite a local field with an external snapshot", () => {
    const draft = createSettingsDraft({
      initial: settings(),
      persist: async () => settings()
    });
    draft.edit({ ai: { provider: "openai-chat-completions" } });
    draft.acceptExternal(settings({ shortcutKey: "Ctrl+K", ai: { ...DEFAULT_SETTINGS.ai, provider: "glossa-backend" } }));
    expect(draft.base.shortcutKey).toBe("Ctrl+K");
    expect(draft.value.shortcutKey).toBe("Ctrl+K");
    expect(draft.value.ai.provider).toBe("openai-chat-completions");
    expect(draft.dirty).toBe(true);
  });

  it("keeps edits made while a save is pending, including a revert", async () => {
    const save = deferred<GlossaSettings>();
    const draft = createSettingsDraft({
      initial: settings(),
      persist: async () => save.promise
    });
    draft.edit({ shortcutKey: "Ctrl+K" });
    const pending = draft.save();
    await drainMicrotasks();
    draft.edit({ shortcutKey: DEFAULT_SETTINGS.shortcutKey });
    save.resolve(settings({ shortcutKey: "Ctrl+K" }));
    await pending;
    expect(draft.base.shortcutKey).toBe("Ctrl+K");
    expect(draft.value.shortcutKey).toBe(DEFAULT_SETTINGS.shortcutKey);
    expect(draft.dirty).toBe(true);
  });

  it("keeps a pending revert through its own storage snapshot", async () => {
    const save = deferred<GlossaSettings>();
    const draft = createSettingsDraft({
      initial: settings(),
      persist: async () => save.promise
    });
    draft.edit({ learningWindowDays: 99 });
    const pending = draft.save();
    await drainMicrotasks();
    draft.edit({ learningWindowDays: DEFAULT_SETTINGS.learningWindowDays });
    draft.acceptExternal(settings({ learningWindowDays: 99 }));
    expect(draft.value.learningWindowDays).toBe(DEFAULT_SETTINGS.learningWindowDays);

    save.resolve(settings({ learningWindowDays: 99 }));
    await pending;
    expect(draft.value.learningWindowDays).toBe(DEFAULT_SETTINGS.learningWindowDays);
    expect(draft.dirty).toBe(true);
  });

  it("treats a reverted edit as clean and accepts a later external update", async () => {
    const patches: unknown[] = [];
    const draft = createSettingsDraft({
      initial: settings(),
      persist: async (patch) => {
        patches.push(patch);
        return settings({ learningWindowDays: 123 });
      }
    });
    draft.edit({ learningWindowDays: 99 });
    draft.edit({ learningWindowDays: DEFAULT_SETTINGS.learningWindowDays });

    await draft.save();

    expect(patches).toEqual([{}]);
    expect(draft.dirty).toBe(false);
    expect(draft.value.learningWindowDays).toBe(123);
    draft.acceptExternal(settings({ learningWindowDays: 456 }));
    expect(draft.value.learningWindowDays).toBe(456);
    expect(draft.dirty).toBe(false);
  });

  it("ignores a duplicate submit while a save is pending", async () => {
    const save = deferred<GlossaSettings>();
    let calls = 0;
    const draft = createSettingsDraft({
      initial: settings(),
      persist: async () => {
        calls += 1;
        return save.promise;
      }
    });
    draft.edit({ knownWordList: "toefl" });
    const first = draft.save();
    const second = draft.save();
    expect(first).toBe(second);
    expect(calls).toBe(1);
    save.resolve(settings({ knownWordList: "toefl" }));
    await first;
  });
});
