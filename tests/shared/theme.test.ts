import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { GLOSSA_THEME } from "../../src/shared/theme";
import themeTokens from "../../src/shared/theme.json";

const cssSurfaces = ["assets/options.css", "assets/popup.css", "ui-preview/preview.css"];

// @verifies glossa.extension_contracts.theme_tokens
describe("extension theme tokens", () => {
  it("exports the shared theme JSON for code-owned UI", () => {
    expect(GLOSSA_THEME).toEqual(themeTokens);
    expect(GLOSSA_THEME.accent).toMatch(/^#[0-9a-f]{6}$/i);
    expect(GLOSSA_THEME.accentRgb).toMatch(/^\d+,\s*\d+,\s*\d+$/);
  });

  it("keeps CSS surfaces on shared theme variables", async () => {
    for (const cssSurface of cssSurfaces) {
      const css = await readFile(cssSurface, "utf8");
      expect(css).toContain("--glossa-theme-accent");
      expect(css).not.toContain(themeTokens.accent);
      expect(css).not.toContain(themeTokens.accentRgb);
    }
  });
});
