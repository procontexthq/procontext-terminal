import { useEffect, useState } from "react";
import type { ReactElement } from "react";

import {
  focusedTerminalSettingsSchema,
  type FocusedTerminalSettings,
  type TerminalConfig,
  type TerminalPresentationMode,
} from "@terminal/protocol";

import { FocusedSettingsShellProfiles } from "./focused-settings-shell-profiles";

const SETTINGS_ERROR_ID = "focused-settings-error";

export function FocusedSettings({
  config,
  onSave,
}: {
  config: TerminalConfig;
  onSave: (settings: FocusedTerminalSettings) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => focusedSettingsFromConfig(config));
  const [redactionPatterns, setRedactionPatterns] = useState(
    config.recording.redactedPatterns.join("\n"),
  );
  const [error, setError] = useState<string | null>(null);
  const [invalidFields, setInvalidFields] = useState<string[]>([]);

  useEffect(() => {
    setDraft(focusedSettingsFromConfig(config));
    setRedactionPatterns(config.recording.redactedPatterns.join("\n"));
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
            <p>Appearance, shells, accessibility, recording, and presentation.</p>
          </header>

          <fieldset>
            <legend>Terminal appearance</legend>
            <label>
              Font family
              <input
                data-testid="setting-font-family"
                {...errorProps("setting-font-family")}
                value={draft.terminal.fontFamily}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    terminal: { ...current.terminal, fontFamily: event.target.value },
                  }))
                }
              />
            </label>
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
            {(["background", "foreground", "cursor"] as const).map((color) => (
              <label key={color}>
                {capitalize(color)} color
                <input
                  data-testid={`setting-color-${color}`}
                  {...errorProps(`setting-color-${color}`)}
                  pattern="#[0-9A-Fa-f]{3}([0-9A-Fa-f]{3})?"
                  title="Use #RGB or #RRGGBB."
                  value={draft.terminal.theme[color]}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      terminal: {
                        ...current.terminal,
                        theme: { ...current.terminal.theme, [color]: event.target.value },
                      },
                    }))
                  }
                />
              </label>
            ))}
          </fieldset>

          <FocusedSettingsShellProfiles
            draft={draft}
            setDraft={setDraft}
            invalidFields={invalidFields}
            errorId={SETTINGS_ERROR_ID}
          />

          <fieldset>
            <legend>Accessibility</legend>
            <label>
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
              Screen reader mode
            </label>
            <label>
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
              Reduce motion
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
