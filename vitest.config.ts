// @constraint requirements.test_config Vitest runs repository tests with jsdom and configured test-file discovery.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    include: ["tests/**/*.test.ts"]
  }
});
