import { describe, expect, it } from "vitest";

import type { UiThemePreference } from "@terminal/protocol";

import { themeFontSet, themeFonts } from "../../src/renderer/theme-fonts";

describe("theme fonts", () => {
  it("defines bundled theme fonts with safe system fallbacks", () => {
    const themes: UiThemePreference[] = ["default", "coder", "gamer", "classic"];

    for (const theme of themes) {
      const fonts = themeFontSet(theme);
      expect(fonts.uiFontFamily).toMatch(/system-ui|monospace/);
      expect(fonts.terminalFontFamily).toContain("monospace");
      expect(fonts.terminalBackground).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("uses distinct terminal font personalities for coder and gamer themes", () => {
    expect(themeFonts.coder.terminalFontFamily).toContain("JetBrains Mono");
    expect(themeFonts.gamer.uiFontFamily).toContain("Orbitron");
    expect(themeFonts.gamer.terminalFontFamily).toContain("Share Tech Mono");
    expect(themeFonts.classic.terminalFontFamily).toContain("IBM Plex Mono");
    expect(themeFonts.gamer.terminalBackground).not.toBe(themeFonts.default.terminalBackground);
  });
});
