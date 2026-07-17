import type { FocusedTerminalSettings, TerminalConfig } from "@terminal/protocol";

export function focusedSettingsFromConfig(config: TerminalConfig): FocusedTerminalSettings {
  return {
    terminal: config.terminal,
    shell: config.shell,
    accessibility: config.accessibility,
    recording: config.recording,
    defaultPresentation: config.defaultPresentation,
  };
}

export function applyUiThemePreset(
  current: FocusedTerminalSettings,
  config: TerminalConfig,
): FocusedTerminalSettings {
  return {
    ...current,
    terminal: {
      ...current.terminal,
      fontFamily: config.terminal.fontFamily,
      theme: { ...current.terminal.theme, background: config.terminal.theme.background },
    },
  };
}
