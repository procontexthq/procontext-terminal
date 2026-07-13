# Implementation and Testing Plan

## Status

Accepted implementation sequence.

## Principles

- Specifications change before or with implementation.
- Public behavior is tested before implementation.
- The new agent API is a deliberate breaking replacement.
- Keep one canonical terminal model and one raw input path.
- Prefer focused modules inside existing packages over new packages.
- Do not add deferred feature services until their implementation phase.

## Phase 1: Core Foundation Rewrite

### Protocol

- Split protocol types and schemas by domain while preserving one package entry.
- Replace the agent command surface with list, get, create, attach, input,
  resize, scroll, observe, close, and advanced recording operations.
- Add fixed protocol-version validation.
- Replace renderer lifecycle state with presentation metadata.
- Replace renderer snapshot messages with view bootstrap and sequenced output.

### Session core

- Add headless xterm.js and matching framebuffer serialization.
- Create one canonical terminal model per PTY session.
- Serialize PTY output and commit versions after parser settlement.
- Add observation waiters, cancellation, shared scroll, atomic resize, and
  bounded close.
- Finalize pending output before exit.
- Preserve exited records when recording finalization fails.

### Desktop

- Replace renderer-owned observation with canonical bootstrap.
- Track renderer views without changing PTY lifecycle.
- Synchronize human and agent scrolling.
- Remove title, bell, snapshot, output replay, and renderer lifecycle reports.
- Keep human tab-close termination confirmation.

### Gateway

- Use one narrow agent terminal service.
- Keep request/response transport and long-poll observation.
- Enforce exclusive agent attachment.
- Release attachment, but not PTY sessions, on disconnect.
- Preserve policy and audit redaction.

### Required tests

- Protocol runtime validation and unsupported versions.
- Headless ANSI, Unicode, wrapping, cursor visibility, title, alternate screen,
  scrollback, and observation versions.
- Output-before-exit settlement.
- Observation timeout and cancellation cleanup.
- Raw mixed-origin input ordering.
- Renderer bootstrap during concurrent output.
- Bidirectional shared viewport synchronization.
- Exclusive agent attachment and disconnect release.
- Recording authorization, ordering, redaction, failure, and export.
- Electron smoke coverage for human and headless agent sessions.

## Phase 2: One-Shot Execution

- Add captured process operations for `tty: false`.
- Add temporary command PTYs for `tty: true`.
- Retain stdout and stderr separately for captured operations.
- Default to 1 MiB per stream with a per-request maximum of 16 MiB.
- Expire completed captured and headless temporary operations after 10 minutes.
- Keep completed presented terminal views until explicitly closed.

## Phase 3: Presentation Automation

- Add `headless`, `background`, and `foreground` requests.
- Correlate open, focus, hide, and close commands with renderer acknowledgements.
- Preserve headless control when renderer creation or focus fails.
- Keep one presented view per session.

## Phase 4: Shell Integration

- Inject supported shell hooks after normal startup configuration.
- Parse private versioned OSC markers with per-session nonce validation.
- Expose capability, prompt, command lifecycle, cwd, command line, and exit code.
- Report degraded or unavailable integration without affecting shell execution.
- Ignore untrusted nested and remote markers.

## Phase 5: Human UX And Release Hardening

- Add panes, search, links, settings UI, window restoration, accessibility, and
  packaging verification.
- Expand platform coverage for macOS, Linux, Windows, ConPTY, and supported
  shells.

## Verification

Every implementation phase runs:

```bash
pnpm lint
pnpm format
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
```

Avoid fixed sleeps. Use parser callbacks, lifecycle events, cancellable
observation waits, and retrying UI assertions.
