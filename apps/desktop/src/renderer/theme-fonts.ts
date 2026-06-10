import type { UiThemePreference } from "@terminal/protocol";

export type ThemeFontSet = {
  uiFontFamily: string;
  uiFontFace: string;
  uiFontWeight: number;
  terminalFontFamily: string;
  terminalFontFace: string;
  terminalFontWeight: number;
  terminalBackground: string;
};

const systemSansFallback =
  'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const systemMonoFallback =
  'ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", monospace';

export const themeFonts: Record<UiThemePreference, ThemeFontSet> = {
  default: {
    uiFontFamily: `"Inter", ${systemSansFallback}`,
    uiFontFace: "Inter",
    uiFontWeight: 400,
    terminalFontFamily: `"JetBrains Mono", ${systemMonoFallback}`,
    terminalFontFace: "JetBrains Mono",
    terminalFontWeight: 400,
    terminalBackground: "#101214",
  },
  coder: {
    uiFontFamily: `"Inter", ${systemSansFallback}`,
    uiFontFace: "Inter",
    uiFontWeight: 400,
    terminalFontFamily: `"JetBrains Mono", ${systemMonoFallback}`,
    terminalFontFace: "JetBrains Mono",
    terminalFontWeight: 400,
    terminalBackground: "#091019",
  },
  gamer: {
    uiFontFamily: `"Orbitron", ${systemSansFallback}`,
    uiFontFace: "Orbitron",
    uiFontWeight: 500,
    terminalFontFamily: `"Share Tech Mono", ${systemMonoFallback}`,
    terminalFontFace: "Share Tech Mono",
    terminalFontWeight: 400,
    terminalBackground: "#07100d",
  },
  classic: {
    uiFontFamily: `"IBM Plex Mono", ${systemMonoFallback}`,
    uiFontFace: "IBM Plex Mono",
    uiFontWeight: 400,
    terminalFontFamily: `"IBM Plex Mono", ${systemMonoFallback}`,
    terminalFontFace: "IBM Plex Mono",
    terminalFontWeight: 400,
    terminalBackground: "#15130f",
  },
};

export function themeFontSet(theme: UiThemePreference): ThemeFontSet {
  return themeFonts[theme];
}

export function themeFontLoadDescriptors(fonts: ThemeFontSet, terminalFontSize: number): string[] {
  return [
    fontLoadDescriptor({
      family: fonts.uiFontFace,
      size: 12,
      weight: fonts.uiFontWeight,
    }),
    fontLoadDescriptor({
      family: fonts.terminalFontFace,
      size: terminalFontSize,
      weight: fonts.terminalFontWeight,
    }),
  ];
}

function fontLoadDescriptor({
  family,
  size,
  weight,
}: {
  family: string;
  size: number;
  weight: number;
}): string {
  return `${weight} ${size}px ${quoteFontFamily(family)}`;
}

function quoteFontFamily(family: string): string {
  return `"${family.replaceAll('"', '\\"')}"`;
}
