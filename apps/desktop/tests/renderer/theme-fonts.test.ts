import { describe, expect, it } from "vitest";

import type { UiThemePreference } from "@terminal/protocol";

import { themeFontLoadDescriptors, themeFontSet, themeFonts } from "../../src/renderer/theme-fonts";

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

  it("defines explicit font loading descriptors for the selected theme", () => {
    expect(themeFontLoadDescriptors(themeFonts.gamer, 13)).toEqual([
      '500 12px "Orbitron"',
      '400 13px "Share Tech Mono"',
    ]);
    expect(
      themeFontLoadDescriptors(themeFonts.gamer, 16, 'Consolas, "Courier New", monospace'),
    ).toEqual(['500 12px "Orbitron"', '400 16px "Consolas"']);
  });
});
