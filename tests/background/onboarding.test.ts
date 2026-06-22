import { describe, expect, it, vi } from "vitest";

import { openOnboardingAfterInstall } from "../../src/background/onboarding";

// @verifies glossa.onboarding.install_open
describe("onboarding install hook", () => {
  it("opens the first-run onboarding page only after a fresh install", () => {
    const create = vi.fn();
    Reflect.set(globalThis, "chrome", {
      runtime: {
        getURL(path: string) {
          return `chrome-extension://glossa/${path}`;
        }
      },
      tabs: { create }
    });

    openOnboardingAfterInstall({ reason: "install", previousVersion: undefined, id: "glossa" });
    openOnboardingAfterInstall({ reason: "update", previousVersion: "0.1.0", id: "glossa" });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({ url: "chrome-extension://glossa/onboarding/onboarding.html" });
  });
});
