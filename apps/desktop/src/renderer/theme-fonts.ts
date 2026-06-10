import type { UiThemePreference } from "@terminal/protocol";

export type ThemeFontSet = {
  uiFontFamily: string;
  terminalFontFamily: string;
  terminalBackground: string;
};

const systemSansFallback =
  'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const systemMonoFallback =
  'ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", monospace';

export const themeFonts: Record<UiThemePreference, ThemeFontSet> = {
  default: {
    uiFontFamily: `"Inter", ${systemSansFallback}`,
    terminalFontFamily: `"JetBrains Mono", ${systemMonoFallback}`,
    terminalBackground: "#101214",
  },
  coder: {
    uiFontFamily: `"Inter", ${systemSansFallback}`,
    terminalFontFamily: `"JetBrains Mono", ${systemMonoFallback}`,
    terminalBackground: "#091019",
  },
  gamer: {
    uiFontFamily: `"Orbitron", ${systemSansFallback}`,
    terminalFontFamily: `"Share Tech Mono", ${systemMonoFallback}`,
    terminalBackground: "#07100d",
  },
  classic: {
    uiFontFamily: `"IBM Plex Mono", ${systemMonoFallback}`,
    terminalFontFamily: `"IBM Plex Mono", ${systemMonoFallback}`,
    terminalBackground: "#15130f",
  },
};

export function themeFontSet(theme: UiThemePreference): ThemeFontSet {
  return themeFonts[theme];
}
