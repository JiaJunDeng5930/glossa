import { stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

class MissingPlaywrightChromiumError extends Error {}

export default async function checkPlaywrightChromium() {
  const executablePath = chromium.executablePath();

  try {
    const info = await stat(executablePath);
    if (info.isFile()) {
      return;
    }
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
  }

  throw new MissingPlaywrightChromiumError([
    "Playwright Chromium is missing.",
    `Expected executable: ${executablePath}`,
    "Bootstrap command: npm run e2e:bootstrap",
    "Then run: npm run test:e2e"
  ].join("\n"));
}

function isMissingPathError(error) {
  return error && typeof error === "object" && "code" in error
    && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await checkPlaywrightChromium();
  } catch (error) {
    if (error instanceof MissingPlaywrightChromiumError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}
