// @behavior glossa.onboarding.install_open Fresh extension installs open the first-run onboarding page in a new tab.
export function openOnboardingAfterInstall(details: chrome.runtime.InstalledDetails): void {
  if (details.reason !== "install") {
    return;
  }
  const runtime = globalThis.chrome?.runtime;
  const tabs = globalThis.chrome?.tabs;
  // @constraint glossa.onboarding.install_open.chrome_api_guard The install hook checks runtime URL and tab creation APIs before opening onboarding.
  if (!runtime?.getURL || !tabs?.create) {
    return;
  }
  // @behavior glossa.onboarding.install_open.tab_url The install hook opens the bundled onboarding HTML through the extension runtime URL.
  void tabs.create({ url: runtime.getURL("onboarding/onboarding.html") });
}
