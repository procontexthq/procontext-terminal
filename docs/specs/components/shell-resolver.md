# Shell Resolver

## Status

Accepted component architecture.

## Purpose

The shell resolver determines the default shell and available shell profiles for PTY sessions. It turns user settings and platform defaults into validated launch requests.

This component is part of the [Terminal Architecture Spec](../terminal-architecture.md).

## Responsibilities

- Detect the user's default shell.
- Support explicit shell profiles.
- Provide platform defaults.
- Validate shell paths and PATH-resolved shell names before PTY spawn.
- Build environment variables without leaking app internals.
- Avoid hardcoded Unix-only path assumptions.
- Return structured errors for invalid profiles or unavailable shells.

## Platform Defaults

- macOS: user default shell, commonly `zsh`.
- Linux: user default shell, commonly `bash`, `zsh`, or `fish`.
- Windows: PowerShell first, with cmd and configured WSL distributions available as profiles.

## Boundaries

The shell resolver must not:

- Spawn PTYs directly.
- Store settings by itself.
- Read renderer UI state.
- Assume Unix paths on Windows.
- Log full environment values when redaction is required.

## Environment Construction

Environment construction must be explicit and testable.

- Start from a defined base environment.
- Apply shell profile overrides.
- Apply workspace or app-specific environment additions only when documented.
- Avoid leaking app internals into child process environments.
- Preserve platform-specific casing and path semantics.

## Working Directory Contract

The shell resolver receives a resolved session working directory from the
session manager. It must not use the packaged app process working directory as
the user-facing terminal default. Main-process launch policy chooses the
native terminal default working directory before shell resolution so session
metadata and PTY spawn behavior remain identical.

## Shell Path Contract

Explicit shell values must be either absolute executable paths for the current
platform or bare command names resolved through `PATH`. Relative path-like
values such as `./shell`, `../bin/shell`, or `tools/shell` are invalid because
their resolution depends on the app process working directory rather than the
terminal session working directory.

## Testing Expectations

- Default shell resolution works for each supported platform.
- Resolved shell metadata is the same metadata reported in session snapshots.
- Invalid shell paths fail with structured errors.
- Shell profile overrides produce expected launch requests.
- Environment construction preserves required variables and redacts sensitive values in logs.
