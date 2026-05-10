// @constraint requirements.test_config.browser Playwright runs e2e tests against Desktop Chrome with the extension test server.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:4173"
  }
});
