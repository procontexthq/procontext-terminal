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

Status: implemented.

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

Status: implemented.

### Protocol

- Add branded operation IDs and validated `terminal.run` requests.
- Extend `terminal.observe` and `terminal.close` with operation targets.
- Default initial waits to 10 seconds with a validated 120-second maximum.
- Add captured output limits of 1 MiB per stream by default and 16 MiB maximum.
- Reject PTY output-limit overrides and Phase 3 background or foreground
  presentation requests. Captured runs may omit presentation or explicitly use
  `headless`.

### Process and session core

- Add a captured-process host using ordinary child-process pipes.
- Add a terminal operation manager for one-shot lifecycle, output journals,
  incremental observation, close, and retention.
- Add temporary command PTYs for `tty: true` while reusing canonical session
  state and interaction.
- Retain stdout and stderr separately for captured operations.
- Retain the newest bytes when a bounded journal overflows.
- Complete temporary PTY runs only after process exit and canonical output
  settlement.
- Expire completed captured and headless temporary operations after 10 minutes.
- Never expire active operations.

### Gateway and desktop

- Add `terminal.run` dispatch and safe policy metadata without command text.
- Automatically attach the creating agent connection to a running temporary PTY
  session.
- Permit authenticated operation-ID observation and close after reconnect while
  preserving exclusive attachment for PTY session interaction.
- Compose the operation manager in Electron main without adding renderer APIs.

### Required tests

- Captured completion, non-zero exit, spawn failure, timeout, and close.
- Separate stdout and stderr journals, tail truncation, and incremental output.
- Temporary PTY completion settlement, raw TUI input, resize, and close.
- Exclusive attachment for temporary PTY sessions.
- Operation reconnect, expiration, and active-operation retention.
- Protocol, policy, gateway, integration, and cross-platform shell invocation.

Phase 2 supports only headless temporary PTY runs. Completed presented terminal
views remain a Phase 3 responsibility.

## Phase 3: Presentation Automation

Status: implemented.

### Protocol

- Add optional `headless`, `background`, and `foreground` presentation to
  create, attach, and temporary-PTY run requests.
- Add idempotent `terminal.setPresentation`.
- Add correlated renderer open, focus, hide, and close commands plus typed
  acknowledgements.
- Keep captured runs headless because they do not own terminal views.

### Desktop and session composition

- Keep presentation state in the canonical session summary and observation.
- Open at most one renderer view per session.
- Wait for renderer readiness and command acknowledgement before committing a
  settled background or foreground state.
- Report actual window visibility and focus after foreground requests.
- Return sessions to headless state after acknowledged hide.
- Mark presentation unavailable, while keeping the PTY headlessly usable, when
  window creation, renderer readiness, open, or focus fails.

### Gateway and operations

- Apply requested presentation during create and attach.
- Present temporary PTY runs as soon as their session exists, before the
  initial run wait completes.
- Keep completed presented temporary PTYs until explicit close; retain the
  existing expiry only for completed headless operations.
- Preserve exclusive agent attachment independently from renderer ownership.

### Required tests

- Protocol validation for create, attach, run, and set-presentation requests.
- Correlated renderer acknowledgement, timeout, and renderer-loss cleanup.
- Idempotent background, foreground, and headless transitions.
- One-view-per-session enforcement.
- Background presentation without tab or window focus.
- Foreground presentation with tab and terminal focus.
- Headless fallback after window creation, renderer readiness, open, or focus
  failure.
- Presented temporary PTY creation, completion retention, and explicit close.
- Electron smoke coverage for agent-created and temporary presented sessions.

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
