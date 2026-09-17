import { applySettingsPatch, type SettingsPatch } from "../shared/settings";
import type { ExtensionStorage } from "../storage/db";

// Settings writes serialize only their read/merge/write transaction, never network work.
export function createSettingsService(storage: ExtensionStorage) {
  let writes = Promise.resolve();
  return {
    patch(patch: SettingsPatch) {
      const operation = writes.then(async () => {
        const latest = await storage.settings.get();
        if (Object.keys(patch).length === 0) return latest;
        const next = applySettingsPatch(latest, patch);
        await storage.settings.set(next);
        return next;
      });
      writes = operation.then(() => undefined, () => undefined);
      return operation;
    }
  };
}
