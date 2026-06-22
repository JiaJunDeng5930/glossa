// @behavior glossa.onboarding.install_open Fresh extension installs open the first-run onboarding page in a new tab.
export function openOnboardingAfterInstall(details: chrome.runtime.InstalledDetails): void {
  if (details.reason !== "install") {
    return;
  }
  const runtime = globalThis.chrome?.runtime;
  const tabs = globalThis.chrome?.tabs;
  if (!runtime?.getURL || !tabs?.create) {
    return;
  }
  void tabs.create({ url: runtime.getURL("onboarding/onboarding.html") });
}
