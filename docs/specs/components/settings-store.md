# Settings Store

## Status

Accepted component architecture.

## Purpose

The settings store owns persisted app configuration, schema validation, migrations, and platform-aware configuration paths.

This component is part of the [Terminal Architecture Spec](../terminal-architecture.md).

## Responsibilities

- Store terminal profiles.
- Store theme, font, cursor, scrollback, and accessibility settings.
- Supply the same validated scrollback value to canonical terminal models and
  renderer projections when their sessions and views are created.
- Store policy settings.
- Store recording defaults.
- Migrate settings between schema versions.
- Resolve app data, logs, recordings, and settings paths through platform-aware APIs.
- Phase 1 persists settings as versioned JSON at the Electron `userData`
  settings path.
- Phase 2A uses settings schema version 2. The schema persists terminal,
  shell, recording, and UI theme settings only; human tab layout is runtime UI
  state and must not be restored from settings on restart. The default UI theme
  is `default`; `coder`, `gamer`, and `classic` remain valid persisted choices.
  The default terminal font stack starts with bundled JetBrains Mono and falls
  back to normal platform monospace fonts.
- Phase 5 uses settings schema version 4. It adds accessibility preferences,
  default terminal presentation, and validated primary-window geometry while
  deterministically migrating schema versions 1 through 3. Accessibility
  settings are screen-reader mode, reduced motion, and a minimum contrast ratio.
- Focused renderer writes may update terminal appearance and scrollback, shell
  profiles, accessibility, recording defaults, and default presentation. They
  preserve UI theme, agent policy, and window geometry. Window geometry is
  written independently by the Electron main process.
- The persisted presentation preference must not override agent protocol
  defaults: omitted agent create and temporary-TTY run presentation remains
  `headless`, attach remains unchanged, and explicit agent presentation wins.
  Human startup always retains one visible foreground terminal. Later human New
  Terminal actions use the preference: `foreground` activates the new view,
  `background` opens a view without stealing focus, and `headless` creates the
  PTY without a renderer view so it remains available through Sessions.
- Enabling recording by default starts recording for future PTY-backed human,
  agent, and temporary TTY sessions only. It never retroactively changes an
  existing session and does not apply to captured non-TTY operations.
- UI-theme selection is a terminal appearance preset: it atomically updates the
  UI theme, terminal font family, and terminal background. Later focused
  appearance edits remain authoritative until another UI-theme preset is
  selected.
- The persisted terminal font family remains a CSS font-family string. Friendly
  renderer choices are presentation-only mappings to canonical portable stacks,
  not new persisted enum values. A non-empty custom stack that does not match a
  named renderer choice must round-trip unchanged when unrelated focused
  settings are saved.
- Paired renderer color pickers and hexadecimal text controls write the existing
  terminal background, foreground, and cursor string fields. They do not change
  the settings schema or add derived color-picker state.

## Boundaries

The settings store must not:

- Hardcode Unix-only paths.
- Import renderer UI.
- Import `node-pty` unless a shell profile schema explicitly requires a shared type.
- Decide whether a runtime terminal operation is authorized.
- Store terminal output unless it is part of an explicit recording setting handled by the recorder.

## Validation Rules

Settings must be validated at load time.

- Valid settings are returned as typed configuration.
- Invalid settings fail closed to defaults, except invalid optional window
  geometry, which is isolated to `null` while otherwise valid settings survive.
- Invalid settings produce a visible warning and structured log entry.
- Migrations must be versioned and deterministic.
- Unknown future schema versions must not be silently downgraded.
- Writes must use a safe temporary-file then rename flow.
- Concurrent focused, UI-theme, agent-policy, and window-geometry writes are
  serialized and each field-specific mutation is applied to the latest
  committed configuration.
- Legacy workspace/tab-layout data from earlier builds must be ignored while
  preserving otherwise valid terminal, shell, and recording settings.
- Window geometry must contain finite, bounded integer coordinates, dimensions
  no smaller than the supported app minimum, and the numeric display ID. A
  missing or invalid geometry value resolves to safe primary-display defaults.
- Terminal background, foreground, and cursor colors use portable three- or
  six-digit hexadecimal RGB values so Electron window framing, renderer CSS,
  and xterm resolve the same color instead of applying different fallbacks.
- Named terminal-font selections resolve to canonical stacks with bundled faces
  followed by portable system monospace fallbacks. Other non-empty font-family
  strings remain valid custom values and are not rewritten merely because the
  renderer does not recognize them.

## Persisted Data

The settings store can persist:

- App settings.
- UI theme preference.
- Shell profiles.
- Agent gateway settings.
- Agent policy modes for observation, execution, interaction, presentation,
  recording, and termination.
- Recording defaults.
- Validated window size, position, and display placement.

It must not persist:

- Agent access keys or gateway authentication material. Those belong to the
  dedicated [Agent Access Key Store](./agent-access-key-store.md).
- Secrets from terminal output.
- Full transcripts.
- Tab order, active tabs, session IDs, PTY processes, operations, or workspace
  layouts.

## Testing Expectations

- Valid settings load as typed config.
- Invalid settings fall back to defaults with structured diagnostics.
- Migrations produce expected current-schema output.
- Focused settings writes cannot add tab, session, operation, PTY, transcript,
  or workspace-layout state.
- Invalid or unavailable-display window geometry resolves to visible,
  work-area-clamped primary-display bounds.
- Platform path resolution works for macOS, Linux, and Windows.
- Sensitive values are not logged in plain text.
- Focused settings preserve an unrecognized custom font stack when another
  setting changes, while named choices persist their canonical fallback stacks.
- Color-picker interaction persists the same validated hexadecimal fields as
  direct text entry and requires no schema migration.
