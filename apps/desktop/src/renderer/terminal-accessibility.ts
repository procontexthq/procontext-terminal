export type TerminalAccessibilityPreferences = {
  screenReaderMode: boolean;
  reducedMotion: boolean;
  minimumContrastRatio: number;
};

export type XtermAccessibilityOptions = {
  cursorBlink: boolean;
  minimumContrastRatio: number;
  screenReaderMode: boolean;
};

export function terminalAccessibilityOptions(
  preferences: TerminalAccessibilityPreferences,
): XtermAccessibilityOptions {
  return {
    cursorBlink: !preferences.reducedMotion,
    minimumContrastRatio: preferences.minimumContrastRatio,
    screenReaderMode: preferences.screenReaderMode,
  };
}
