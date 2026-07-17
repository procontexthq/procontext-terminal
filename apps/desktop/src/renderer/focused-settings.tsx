import { useEffect, useState } from "react";
import type { Dispatch, ReactElement, SetStateAction } from "react";

import {
  focusedTerminalSettingsSchema,
  type AgentAccessKeyMetadata,
  type FocusedTerminalSettings,
  type TerminalConfig,
  type TerminalPresentationMode,
} from "@terminal/protocol";

import { FocusedSettingsShellProfiles } from "./focused-settings-shell-profiles";
import { AgentAccessSettings } from "./agent-access-settings";

const SETTINGS_ERROR_ID = "focused-settings-error";
const SYSTEM_MONOSPACE_FONT_STACK =
  'ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", monospace';
const CUSTOM_FONT_CHOICE = "custom";
const TERMINAL_FONT_OPTIONS = [
  {
    id: "jetbrains-mono",
    label: "JetBrains Mono",
    fontFamily: `"JetBrains Mono", ${SYSTEM_MONOSPACE_FONT_STACK}`,
  },
  {
    id: "share-tech-mono",
    label: "Share Tech Mono",
    fontFamily: `"Share Tech Mono", ${SYSTEM_MONOSPACE_FONT_STACK}`,
  },
  {
    id: "ibm-plex-mono",
    label: "IBM Plex Mono",
    fontFamily: `"IBM Plex Mono", ${SYSTEM_MONOSPACE_FONT_STACK}`,
  },
  {
    id: "system-monospace",
    label: "System monospace",
    fontFamily: SYSTEM_MONOSPACE_FONT_STACK,
  },
] as const;

type TerminalFontChoice = (typeof TERMINAL_FONT_OPTIONS)[number]["id"] | typeof CUSTOM_FONT_CHOICE;

export function FocusedSettings({
  config,
  onSave,
  agentAccess,
}: {
  config: TerminalConfig;
  onSave: (settings: FocusedTerminalSettings) => void;
  agentAccess?: {
    metadata: AgentAccessKeyMetadata;
    onCopy: () => Promise<void>;
    onRegenerate: () => Promise<AgentAccessKeyMetadata>;
    onError: (error: unknown) => void;
  };
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => focusedSettingsFromConfig(config));
  const [redactionPatterns, setRedactionPatterns] = useState(
    config.recording.redactedPatterns.join("\n"),
  );
  const [fontChoice, setFontChoice] = useState<TerminalFontChoice>(() =>
    terminalFontChoice(config.terminal.fontFamily),
  );
  const [error, setError] = useState<string | null>(null);
  const [invalidFields, setInvalidFields] = useState<string[]>([]);

  useEffect(() => {
    setDraft(focusedSettingsFromConfig(config));
    setRedactionPatterns(config.recording.redactedPatterns.join("\n"));
    setFontChoice(terminalFontChoice(config.terminal.fontFamily));
    setError(null);
    setInvalidFields([]);
  }, [config]);

  const save = (): void => {
    const patterns = redactionPatterns
      .split(/\r?\n/u)
      .map((pattern) => pattern.trim())
      .filter(Boolean);
    if (!patterns.every(isValidPattern)) {
      setError("Check the highlighted settings. Every redaction pattern must be a valid regex.");
      setInvalidFields(["recording-redaction-patterns"]);
      return;
    }
    const parsed = focusedTerminalSettingsSchema.safeParse({
      ...draft,
      recording: { ...draft.recording, redactedPatterns: patterns },
    });
    if (!parsed.success) {
      setError("Check the highlighted settings before saving.");
      setInvalidFields(
        parsed.error.issues
          .map((issue) => settingTestIdForPath(issue.path))
          .filter((testId): testId is string => testId !== null),
      );
      return;
    }
    setError(null);
    setInvalidFields([]);
    onSave(parsed.data);
  };

  const errorProps = (testId: string) =>
    invalidFields.includes(testId)
      ? ({ "aria-describedby": SETTINGS_ERROR_ID, "aria-invalid": true } as const)
      : {};

  return (
    <div className="focused-settings">
      <button
        type="button"
        className={`focused-settings-toggle${open ? " is-active" : ""}`}
        aria-label="Terminal settings"
        aria-expanded={open}
        title="Terminal settings"
        data-testid="focused-settings-toggle"
        onClick={() => setOpen((current) => !current)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.4 1a8 8 0 0 0-1.8-1L14.4 3h-4.8l-.4 3.1a8 8 0 0 0-1.8 1L5 6.1 3 9.5 5.1 11a7 7 0 0 0 0 2L3 14.5l2 3.4 2.4-1a8 8 0 0 0 1.8 1l.4 3.1h4.8l.4-3.1a8 8 0 0 0 1.8-1l2.4 1 2-3.4-2.1-1.5a7 7 0 0 0 .1-1Z" />
        </svg>
        <span className="visually-hidden">Terminal settings</span>
      </button>
      {open ? (
        <section className="focused-settings-panel" aria-label="Terminal settings">
          <header>
            <strong>Terminal settings</strong>
            <p>Appearance, shells, agent access, accessibility, recording, and presentation.</p>
          </header>

          <fieldset>
            <legend>Terminal appearance</legend>
            <label>
              Terminal font
              <select
                data-testid="setting-font-family"
                {...errorProps("setting-font-family")}
                value={fontChoice}
                onChange={(event) => {
                  const choice = terminalFontOption(event.target.value);
                  if (!choice) {
                    setFontChoice(CUSTOM_FONT_CHOICE);
                    return;
                  }
                  setFontChoice(choice.id);
                  setDraft((current) => ({
                    ...current,
                    terminal: { ...current.terminal, fontFamily: choice.fontFamily },
                  }));
                }}
              >
                {TERMINAL_FONT_OPTIONS.map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {choice.label}
                  </option>
                ))}
                <option value={CUSTOM_FONT_CHOICE}>Custom</option>
              </select>
            </label>
            {fontChoice === CUSTOM_FONT_CHOICE ? (
              <label className="focused-settings-full-width">
                Custom font stack
                <input
                  data-testid="setting-font-family-custom"
                  {...errorProps("setting-font-family")}
                  value={draft.terminal.fontFamily}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      terminal: { ...current.terminal, fontFamily: event.target.value },
                    }))
                  }
                />
                <span className="setting-help">
                  Fonts are tried from left to right; the first available font is used.
                </span>
              </label>
            ) : null}
            <label>
              Font size
              <input
                type="number"
                min="8"
                max="40"
                data-testid="setting-font-size"
                {...errorProps("setting-font-size")}
                value={draft.terminal.fontSize}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    terminal: { ...current.terminal, fontSize: Number(event.target.value) },
                  }))
                }
              />
            </label>
            <label>
              Scrollback rows
              <input
                type="number"
                min="100"
                max="100000"
                data-testid="setting-scrollback"
                {...errorProps("setting-scrollback")}
                value={draft.terminal.scrollback}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    terminal: { ...current.terminal, scrollback: Number(event.target.value) },
                  }))
                }
              />
            </label>
            {(["background", "foreground", "cursor"] as const).map((color) => {
              const label = `${capitalize(color)} color`;
              const textInputId = `setting-color-${color}-value`;
              return (
                <div className="focused-settings-color-field" key={color}>
                  <label htmlFor={textInputId}>{label}</label>
                  <div className="focused-settings-color-controls">
                    <input
                      id={textInputId}
                      type="text"
                      data-testid={`setting-color-${color}`}
                      {...errorProps(`setting-color-${color}`)}
                      pattern="#[0-9A-Fa-f]{3}([0-9A-Fa-f]{3})?"
                      title="Use #RGB or #RRGGBB."
                      value={draft.terminal.theme[color]}
                      onChange={(event) => setTerminalColor(setDraft, color, event.target.value)}
                    />
                    <input
                      type="color"
                      data-testid={`setting-color-${color}-picker`}
                      aria-label={`Choose ${color} color`}
                      title={`Choose ${color} color`}
                      value={colorPickerValue(draft.terminal.theme[color])}
                      onChange={(event) => setTerminalColor(setDraft, color, event.target.value)}
                    />
                  </div>
                </div>
              );
            })}
          </fieldset>

          <FocusedSettingsShellProfiles
            draft={draft}
            setDraft={setDraft}
            invalidFields={invalidFields}
            errorId={SETTINGS_ERROR_ID}
          />

          {agentAccess ? <AgentAccessSettings {...agentAccess} /> : null}

          <fieldset>
            <legend>Accessibility</legend>
            <label className="focused-settings-checkbox">
              <input
                type="checkbox"
                data-testid="accessibility-screen-reader"
                {...errorProps("accessibility-screen-reader")}
                checked={draft.accessibility.screenReaderMode}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    accessibility: {
                      ...current.accessibility,
                      screenReaderMode: event.target.checked,
                    },
                  }))
                }
              />
              <span className="focused-settings-checkbox-label">Screen reader mode</span>
            </label>
            <label className="focused-settings-checkbox">
              <input
                type="checkbox"
                data-testid="accessibility-reduced-motion"
                {...errorProps("accessibility-reduced-motion")}
                checked={draft.accessibility.reducedMotion}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    accessibility: {
                      ...current.accessibility,
                      reducedMotion: event.target.checked,
                    },
                  }))
                }
              />
              <span className="focused-settings-checkbox-label">Reduce motion</span>
            </label>
            <label>
              Minimum contrast ratio
              <input
                type="number"
                min="1"
                max="21"
                step="0.1"
                data-testid="accessibility-minimum-contrast"
                {...errorProps("accessibility-minimum-contrast")}
                value={draft.accessibility.minimumContrastRatio}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    accessibility: {
                      ...current.accessibility,
                      minimumContrastRatio: Number(event.target.value),
                    },
                  }))
                }
              />
            </label>
          </fieldset>

          <fieldset>
            <legend>Recording defaults</legend>
            <label>
              Default recording state
              <select
                data-testid="recording-default-state"
                {...errorProps("recording-default-state")}
                value={draft.recording.state}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    recording: {
                      ...current.recording,
                      state: event.target.value === "enabled" ? "enabled" : "disabled",
                    },
                  }))
                }
              >
                <option value="disabled">Disabled</option>
                <option value="enabled">Enabled</option>
              </select>
            </label>
            <label>
              Redaction patterns, one regex per line
              <textarea
                data-testid="recording-redaction-patterns"
                {...errorProps("recording-redaction-patterns")}
                value={redactionPatterns}
                onChange={(event) => setRedactionPatterns(event.target.value)}
              />
            </label>
          </fieldset>

          <label>
            New terminal presentation
            <select
              data-testid="setting-default-presentation"
              {...errorProps("setting-default-presentation")}
              value={draft.defaultPresentation}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  defaultPresentation: parsePresentation(event.target.value),
                }))
              }
            >
              <option value="headless">Headless</option>
              <option value="background">Background</option>
              <option value="foreground">Foreground</option>
            </select>
            <span className="setting-help">
              Applies after startup. Headless terminals remain available in Sessions.
            </span>
          </label>

          {error ? (
            <p id={SETTINGS_ERROR_ID} role="alert">
              {error}
            </p>
          ) : null}
          <button type="button" data-testid="focused-settings-save" onClick={save}>
            Save settings
          </button>
        </section>
      ) : null}
    </div>
  );
}

function focusedSettingsFromConfig(config: TerminalConfig): FocusedTerminalSettings {
  return {
    terminal: config.terminal,
    shell: config.shell,
    accessibility: config.accessibility,
    recording: config.recording,
    defaultPresentation: config.defaultPresentation,
  };
}

function parsePresentation(value: string): TerminalPresentationMode {
  return value === "headless" || value === "background" ? value : "foreground";
}

function isValidPattern(pattern: string): boolean {
  try {
    new RegExp(pattern, "gu");
    return true;
  } catch {
    return false;
  }
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function terminalFontChoice(fontFamily: string): TerminalFontChoice {
  return terminalFontOptionByFamily(fontFamily)?.id ?? CUSTOM_FONT_CHOICE;
}

function terminalFontOption(value: string) {
  return TERMINAL_FONT_OPTIONS.find((option) => option.id === value);
}

function terminalFontOptionByFamily(fontFamily: string) {
  return TERMINAL_FONT_OPTIONS.find((option) => option.fontFamily === fontFamily);
}

function colorPickerValue(value: string): string {
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/iu.exec(value);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  return /^#[0-9a-f]{6}$/iu.test(value) ? value : "#000000";
}

function setTerminalColor(
  setDraft: Dispatch<SetStateAction<FocusedTerminalSettings>>,
  color: keyof FocusedTerminalSettings["terminal"]["theme"],
  value: string,
): void {
  setDraft((current) => ({
    ...current,
    terminal: {
      ...current.terminal,
      theme: { ...current.terminal.theme, [color]: value },
    },
  }));
}

function settingTestIdForPath(path: PropertyKey[]): string | null {
  const [section, field, index, profileField] = path.map(String);
  if (section === "terminal") {
    if (field === "fontFamily") return "setting-font-family";
    if (field === "fontSize") return "setting-font-size";
    if (field === "scrollback") return "setting-scrollback";
    if (field === "theme" && index) return `setting-color-${index}`;
  }
  if (section === "accessibility") {
    if (field === "screenReaderMode") return "accessibility-screen-reader";
    if (field === "reducedMotion") return "accessibility-reduced-motion";
    if (field === "minimumContrastRatio") return "accessibility-minimum-contrast";
  }
  if (section === "recording") {
    return field === "state" ? "recording-default-state" : "recording-redaction-patterns";
  }
  if (section === "defaultPresentation") return "setting-default-presentation";
  if (section === "shell" && field === "defaultProfile") return "shell-default-profile";
  if (section === "shell" && field === "profiles" && index && profileField) {
    const control = profileField === "name" ? "name" : profileField === "cwd" ? "cwd" : "shell";
    return `shell-profile-${control}-${index}`;
  }
  return null;
}
