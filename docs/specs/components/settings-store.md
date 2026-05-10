# Settings Store

## Status

Accepted component architecture.

## Purpose

The settings store owns persisted app configuration, schema validation, migrations, and platform-aware configuration paths.

This component is part of the [Terminal Architecture Spec](../terminal-architecture.md).

## Responsibilities

- Store terminal profiles.
- Store theme, font, cursor, scrollback, and accessibility settings.
- Store agent gateway settings.
- Store policy settings.
- Store recording defaults.
- Migrate settings between schema versions.
- Resolve app data, logs, recordings, and settings paths through platform-aware APIs.
- In Phase 1, persist settings as versioned JSON at the Electron `userData` settings path.

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
- Invalid settings fail closed to defaults.
- Invalid settings produce a visible warning and structured log entry.
- Migrations must be versioned and deterministic.
- Unknown future schema versions must not be silently downgraded.
- Writes must use a safe temporary-file then rename flow.

## Persisted Data

The settings store can persist:

- App settings.
- Shell profiles.
- Agent gateway settings.
- Policy settings.
- Recording defaults.
- Window state.

It must not persist:

- Expired agent tokens.
- Secrets from terminal output.
- Full transcripts.

## Testing Expectations

- Valid settings load as typed config.
- Invalid settings fall back to defaults with structured diagnostics.
- Migrations produce expected current-schema output.
- Platform path resolution works for macOS, Linux, and Windows.
- Sensitive values are not logged in plain text.
