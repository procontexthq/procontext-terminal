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

Status: implemented.

- Add a focused shell-integration package for supported-shell detection,
  bootstrap generation, trusted marker parsing, and temporary resource cleanup.
- Inject supported shell hooks after normal startup configuration.
- Parse private versioned OSC 633 markers with per-session 128-bit nonce
  validation and bounded base64url payloads.
- Expose capability, prompt, command lifecycle, current cwd, command line, and
  exit code through canonical session summaries and observations.
- Report degraded or unavailable integration without affecting shell execution.
- Ignore untrusted nested and remote markers.

### Required tests

- Protocol validation for observed cwd and shell-integration state.
- Supported-shell detection, launch rewriting, startup chaining, and cleanup.
- Marker prefix, version, nonce, encoding, field limits, and malformed input.
- Capability negotiation, timeout, recovery, prompt, cwd, command start,
  command finish, exit code, and unfinished-command shell exit.
- Unsupported, temporary, nested, and remote shell behavior.
- Real PTY and Electron smoke coverage for available supported shells.

## Phase 5: Human UX And Release Hardening

Status: planned.

### Phase 5A: Human-Agent Collaboration Core

Status: implemented.

- Keep canonical terminal summaries independent from gateway connection ownership.
- Add renderer-only agent-control state keyed by session ID with attached,
  detached, or revoked state and an optional attachment timestamp. Never expose
  gateway connection identifiers.
- Add renderer commands to list, revoke, and allow agent control and to export
  a recording through a native save dialog.
- Add renderer events for agent-control changes, sanitized policy denials, and
  removed session records.
- Let revocation cancel pending observation for the selected session and deny
  future attachment and control operations without terminating the PTY or
  disconnecting the agent from other sessions. Revoked control remains blocked
  for every agent connection until a human explicitly allows control again.
- Add a non-persisted session sidebar for visible and headless sessions.
- Keep status summaries privacy-safe: command state may be shown, but command
  lines, terminal contents, environment values, and transcript data are not.
- Add reveal, focus, hide, revoke, terminate or remove, and recording actions
  while preserving the separate PTY, renderer-view, and agent-control
  lifecycles.
- Show whether recording redaction is configured using only a pattern count;
  never expose the configured pattern values in collaboration UI.
- Keep canonical foreground/background presentation synchronized when humans
  reveal or switch terminal tabs.
- Surface policy denials and action failures in a bounded, accessible,
  in-memory notification area.
- Keep interactive per-request approval queues deferred to a later Phase 5
  collaboration milestone.

### Phase 5B: Interactive Agent Permissions

Status: implemented.

- Add persisted `allow`, `ask`, or `deny` modes for agent observation,
  execution, interaction, presentation, recording, and termination categories.
- Preserve current behavior by defaulting every category to `allow` when
  migrating existing settings.
- Convert `ask` policy decisions into privacy-safe, 30-second permission
  requests. Prompts include operation category, operation name, session ID when
  present, and timestamps only.
- Never include command text, terminal input or output, environment values,
  transcript data, gateway connection IDs, or authentication material.
- Let the first renderer resolution allow the operation once or deny it.
  Disconnect, timeout, shutdown, and unavailable UI resolve safely as denial.
- Expose pending requests to newly opened renderer windows and remove resolved
  requests from every renderer.
- Add a focused agent-policy settings panel without introducing a general
  command palette or broad settings framework.

### Human-agent collaboration

- Add a session list that includes visible and headless sessions without
  introducing a second terminal-state model.
- Show session origin, agent attachment, lifecycle, presentation, cwd,
  top-level command, shell-integration, and recording status.
- Let humans reveal or focus agent sessions and revoke agent control without
  implicitly terminating the shared PTY.
- Surface policy denials and configured permission prompts through the desktop
  UI with clear allow, deny, detach, hide, and terminate outcomes.
- Add explicit recording start, stop, export, and redaction-status controls.
- Keep activity summaries coarse and privacy-safe; do not expose terminal
  input, output, command lines, environment values, or transcript contents as
  diagnostics.

### Focused terminal usability

Status: implemented.

- Add local terminal search over the human-visible xterm scrollback.
- Add validated clickable URLs and local file paths without turning terminal
  output into trusted application commands.
- Add a focused settings UI for shell profiles, terminal appearance,
  scrollback, accessibility, recording, agent policy, and default presentation
  behavior.
- Improve keyboard-only navigation, focus indication, screen-reader labels and
  announcements, contrast, and reduced-motion behavior.
- Persist validated window size, position, and display placement only.

### Release hardening

Status: implementation complete; credentialed verification requires the first
tagged release.

- Expand PTY, shell-integration, TUI, reconnect, renderer-loss, and shutdown
  coverage across macOS, Linux, Windows, ConPTY, and supported shells.
- Require PowerShell Core in the macOS, Linux, and Windows pull-request matrix so
  the same real-PTY negotiation and command-lifecycle contract is exercised on
  every supported desktop platform.
- Preserve canonical alternate-buffer identity on Windows with the bundled
  ConPTY transport. Handle its one-shot startup device-attribute query at the
  PTY boundary, remove that transport handshake before terminal models can
  answer it again, and verify both PowerShell startup and exact alternate-buffer
  state.
- Return subsequent terminal-generated protocol responses from the canonical
  emulator on every platform, including for headless sessions, and annotate
  renderer output with ordered per-response outcomes so projections cannot echo
  successful responses or misassociate partial write failures.
- Prepare `node-pty` for the target platform during dependency installation.
  Electron Builder must preserve that Node-API-compatible platform artifact
  instead of rebuilding the dependency a second time during packaging.
- In pull-request CI, build the unpacked desktop application on every target
  operating system, verify the packaged native PTY layout, and launch a packaged
  smoke session that exercises both human and agent terminal operations. Package
  from the verified Electron distribution installed for the current host rather
  than extracting a second archive into the output directory; this avoids the
  Windows atomic staging-directory rename race without retrying compilation or
  runtime assertions. Release workflows additionally build and verify the
  distributable installers.
- Verify packaged native PTY behavior, installers, artifact generation,
  signing or notarization inputs, and release provenance.
- Keep local and pull-request packaging explicitly unsigned. Tagged and manual
  release runs must target the package version tag and fail before packaging
  when platform signing, macOS notarization, or provenance inputs are missing.
- Validate the generated DMG, NSIS, AppImage, and deb artifacts with native
  platform tools before upload. Verify installed or extracted application
  layout and native PTY content, launch each mounted, installed, or extracted
  application, then verify GitHub's generated provenance attestation for every
  uploaded installer.
- On Windows, require valid Authenticode signatures on both the NSIS wrapper and
  the installed application executable; report only the artifact role and
  signature status when validation fails.

### Explicitly out of scope

- Split panes or pane layout management.
- Persisted tab or workspace layouts.
- Restoring terminal sessions, operations, tabs, or PTY runtime state after app
  restart.
- A broad command palette or general-purpose command framework.

### Required tests

- Protocol validation for agent-control, policy-denial, recording-file-export,
  and session-removal messages.
- Gateway attachment listing, session-scoped revocation, observation
  cancellation, disconnect cleanup, and future ownership denial.
- Session-list and per-session collaboration status for human, agent, headless,
  background, foreground, running, and exited sessions.
- Human reveal, focus, detach, revoke, hide, and terminate behavior without
  accidental PTY lifecycle changes.
- Policy denial, permission prompt, and recording-control UI behavior.
- Search, validated link handling, focused settings, accessibility, and window
  geometry validation.
- Cross-platform packaged-app and native PTY smoke coverage.
- Regression coverage proving excluded layout and session-restoration state is
  not persisted.

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
