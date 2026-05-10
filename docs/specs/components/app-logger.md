# App Logger

## Status

Accepted component architecture.

## Purpose

The app logger records application diagnostics. It is separate from terminal PTY output, transcript recording, and agent observations.

This component is part of the [Terminal Architecture Spec](../terminal-architecture.md).

## Responsibilities

- Log app lifecycle events.
- Log session lifecycle events.
- Log policy decisions.
- Log gateway connections and authentication failures.
- Log internal errors with structured context.
- Persist app diagnostics to the platform app log directory.
- Mirror development logs to stderr for immediate feedback.
- Respect redaction rules.
- Provide enough context to debug cross-process issues.

## Boundaries

The app logger must not:

- Write application logs into PTY output.
- Log terminal output by default.
- Store replay transcripts.
- Decide policy.
- Expose secrets or unredacted sensitive environment values.

## Recommended Fields

- timestamp
- level
- component
- event
- sessionId when relevant
- requestId when relevant
- origin: human, agent, system
- error type and cause when relevant

## Current Phase 1 Behavior

- Logs are JSON Lines, one record per line.
- The main-process log file is `main.log` under Electron's `app.getPath("logs")`.
- Development logging writes to both `main.log` and stderr.
- Packaged logging writes to `main.log` by default.
- `PROCONTEXT_LOG_LEVEL` can override the default log level.
- The default log level is `debug` in development and `info` when packaged.
- Log rotation is size-based: rotate at 5 MB and keep 3 old files.

## Redaction Rules

Log context is sanitized before it is written.

- Redact keys matching password, secret, token, key, auth, credential, cookie, or env.
- Truncate long strings to prevent one event from producing an oversized log record.
- Do not log PTY output, terminal input, clipboard contents, full environment values, transcript data, or agent observations by default.

## Channel Separation

Observability has three separate outputs:

1. App logs for debugging the application.
2. Terminal transcripts for replaying PTY sessions.
3. Agent observations for real-time decision-making.

These outputs must not be mixed. Terminal output should not be logged as app diagnostics by default.

## Testing Expectations

- Logs include component and event names.
- File logs are written as valid JSONL records.
- Development logs are mirrored to stderr.
- File log rotation preserves recent records.
- Terminal output is excluded from app diagnostics unless explicitly enabled for a scoped debugging scenario.
- Redaction removes sensitive values before persistence or export.
- Error logs preserve domain error type and cause context.
