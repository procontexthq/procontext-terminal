# Agent Control Breakage Tracker

## Status

Private working tracker. This is not an accepted public spec.

## Purpose

This tracker captures the agent-control issues found during raw API break
testing. It is written for a new person or agent taking over work in parallel:
each issue includes the observed behavior, why it matters, how to reproduce it,
likely implementation areas, and acceptance criteria.

The product intent behind every issue is the same: an agent should be able to
operate a real terminal session with the same practical control a human has,
while preserving PTY correctness, typed IPC, auditability, and safe local
boundaries.

## Evidence Sources

- `outputs/chaos-terminal-test/senior-break-report.md`
- `outputs/chaos-terminal-test/run-2026-06-10T22-33-50-385Z/chaos-report.md`
- `outputs/chaos-terminal-test/api-gap-2026-06-10T22-35-07-094Z/api-gap-report.md`
- Main app logs captured during the run under the host Electron log path.
- Current accepted spec: `docs/specs/components/agent-gateway.md`
- Current API rethink note: `docs/private/agent-terminal-api-rethink.md`

## Quick Triage Table

| ID | Priority | Status | Issue | Primary Area | Parallelization Notes |
| --- | --- | --- | --- | --- | --- |
| ACT-001 | P1 | Fixed pending review | Startup session listing is racy | Main startup, renderer startup, session manager, gateway readiness | Can be handled independently from API shape work. |
| ACT-002 | P1 | Partially fixed pending review | Agent cannot release or close session records | Protocol, agent gateway, session manager, renderer tabs | `terminal.release` is fixed; visible tab close remains with ACT-006. |
| ACT-003 | P1 | Open | Agent cannot drive mouse-enabled TUIs | Protocol, agent gateway input routing, terminal view/xterm input model | Can be handled independently after input contract is chosen. |
| ACT-004 | P2 | Open | Agent lacks first-class paste semantics | Protocol, gateway, input router, PTY/session input | Can be handled independently from mouse input. |
| ACT-005 | P2 | Open | Agent lacks explicit interrupt command | Protocol, gateway, session manager/input helper | Small, self-contained if scoped to Ctrl+C first. |
| ACT-006 | P2 | Open | Agent cannot focus/select/open visible terminal surfaces | Agent display service, renderer tabs, window manager, gateway | Coordinate with ACT-002 tab close/release behavior. |
| ACT-007 | P2 | Open | Recording is not exposed through the public agent gateway | Protocol, gateway, recorder, session manager | Can be handled independently from terminal input work. |
| ACT-008 | P2 | Fixed pending review | Kill/write/capture/wait races are survivable but underspecified | Specs, protocol errors, gateway/session manager tests | Post-kill write/recent-output behavior is specified and tested. |
| ACT-009 | P3 | Needs triage | Mixed human/agent Computer Use simulation was inconclusive | Accessibility/test tooling, terminal input focus | Testability issue; not yet proven product defect. |
| ACT-010 | P3 | Needs triage | macOS `open` launch with isolated user data hung during test setup | Packaging, app startup, renderer load, gateway startup | Inconclusive; direct executable launch worked. |

## Reproduction Setup

Most raw API issues can be reproduced against a packaged app with an isolated
user data directory:

```bash
pnpm package:current

RUN_ROOT="$(pwd)/outputs/repro-agent-control-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$RUN_ROOT/user-data" "$RUN_ROOT/workspace"

APP="apps/desktop/dist/mac-arm64/ProContext Terminal.app/Contents/MacOS/ProContext Terminal"
"$APP" --user-data-dir="$RUN_ROOT/user-data" &
```

Wait for:

```text
$RUN_ROOT/user-data/agent-gateway.json
```

Then connect to the descriptor `url`, authenticate with the descriptor `token`,
and send command envelopes like:

```json
{
  "type": "agent.authenticate",
  "requestId": "repro-1",
  "payload": { "token": "<descriptor token>" }
}
```

After authentication, agent commands use the same envelope shape:

```json
{
  "type": "terminal.list",
  "requestId": "repro-2",
  "payload": {}
}
```

If the local chaos harness files are present, the fastest reproductions are:

```bash
node outputs/chaos-terminal-test/chaos-harness.mjs
node outputs/chaos-terminal-test/api-gap-harness.mjs
```

## ACT-001: Startup Session Listing Is Racy

### Summary

Immediately after the gateway descriptor appears and an agent authenticates,
`terminal.list` can return an empty list even though the renderer is about to
create the default human startup terminal. In the break run, this caused the
agent to believe it had killed every known session, but a late human-created
startup session remained running.

### Observed Behavior

The API gap harness did this sequence:

1. Launch app with isolated `--user-data-dir`.
2. Wait for `agent-gateway.json`.
3. Authenticate a raw WebSocket client.
4. Immediately call `terminal.list`.
5. Observe `[]`.
6. Create three agent sessions.
7. List all known sessions and kill each listed session.
8. List again.
9. Observe states similar to:

```json
["exited", "exited", "exited", "running"]
```

The extra `running` session was the renderer-created human startup tab that
arrived after the first `terminal.list`.

### Why It Matters

An agent cannot reliably take over the terminal state if the first list call can
return a false empty state. Any workflow like "close everything", "attach to all
active terminals", "snapshot the current terminal state", or "decide whether to
create a new session" can make the wrong decision during startup.

### Expected Behavior

Choose and document one deterministic contract:

- The gateway descriptor is not written until startup session creation is
  settled enough that `terminal.list` reflects the initial human session.
- Or the gateway exposes an explicit readiness/startup-settled state.
- Or the main process, not the renderer, creates/registers the initial session
  before the gateway becomes externally discoverable.

The important part is that an agent should not receive a false empty session
list after the app advertises an available gateway.

### Suggested Implementation Areas

- `apps/desktop/src/main/index.ts`
- `apps/desktop/src/renderer/App.tsx`
- `apps/desktop/src/renderer/terminal-controller.ts`
- `apps/desktop/src/main/ipc.ts`
- `packages/session-core/src/index.ts`
- `packages/agent-gateway/src/index.ts`

### Acceptance Criteria

- A raw agent that authenticates immediately after descriptor creation can
  deterministically see the initial startup session, or can detect that startup
  session creation is still pending.
- The all-closed scenario cannot miss a late startup session.
- The fix is covered by an automated test that reproduces fast gateway connect
  during app startup.

### Suggested Tests

- Packaged or Electron e2e test that connects to the agent gateway immediately
  after descriptor creation and calls `terminal.list`.
- Regression test for "kill every listed session after startup, then no running
  sessions remain unless a new session is intentionally created".

## ACT-002: Agent Cannot Release Or Close Session Records

### Summary

The gateway exposes `terminal.kill`, but it does not expose a way to release an
exited session record or close a visible terminal tab/view. After sessions exit,
they remain in `terminal.list`, and unsupported commands such as
`terminal.release` and `terminal.close` are rejected as `invalid_request`.

### Observed Behavior

The API gap harness killed three agent sessions and then listed sessions again.
Exited sessions remained listed. It then sent unsupported command probes:

```json
{ "type": "terminal.release", "payload": { "sessionId": "<id>" } }
{ "type": "terminal.close", "payload": { "sessionId": "<id>" } }
```

Both were rejected as invalid command payloads.

### Why It Matters

Killing a PTY and closing/releasing a terminal record are different operations.
A human can close tabs and clear dead terminal surfaces. An agent currently
cannot model that lifecycle. Long-running agents can accumulate dead sessions
and cannot cleanly express "remove this finished thing from my working set".

### Expected Behavior

The public agent API should include explicit lifecycle operations. The exact
names can be decided in the spec, but they should cover:

- Kill/terminate the underlying PTY.
- Release/remove an exited session record from the agent-visible list.
- Close a visible tab/view, with clear behavior for whether the PTY is killed,
  detached, or preserved.

### Suggested Implementation Areas

- `packages/protocol/src/index.ts`
- `packages/agent-gateway/src/index.ts`
- `packages/session-core/src/index.ts`
- `apps/desktop/src/main/terminal-command-handler.ts`
- `apps/desktop/src/renderer/terminal-tabs.ts`
- `apps/desktop/src/renderer/App.tsx`

### Acceptance Criteria

- Agent can release an exited session so it no longer appears in
  `terminal.list`.
- Agent receives a typed error when trying to release a running session if the
  chosen contract forbids it.
- Agent can close a visible terminal surface using a documented API.
- Human tab close and agent close/release behavior do not diverge unexpectedly.

### Suggested Tests

- Gateway unit test for `terminal.release` on exited/running/missing sessions.
- E2E test for closing a visible tab through the agent API and verifying the
  renderer tab state.
- Regression test proving repeated create/kill/release cycles do not grow the
  active list.

## ACT-003: Agent Cannot Drive Mouse-Enabled TUIs

### Summary

Keyboard-driven TUIs worked in chaos testing, including `less`, `vim`, and
`git add -p`. Mouse input is not available through the public gateway.
`terminal.sendMouse` is rejected as `invalid_request`.

### Observed Behavior

The API gap harness sent:

```json
{
  "type": "terminal.sendMouse",
  "payload": {
    "sessionId": "<id>",
    "data": "\u001b[M   "
  }
}
```

The gateway rejected it because `terminal.sendMouse` is not part of the accepted
command union.

### Why It Matters

Real terminal work can involve mouse-aware TUIs: editors, fuzzy finders,
debuggers, process monitors, terminal multiplexers, and custom CLIs. If the
goal is for agents to operate the terminal like a human, keyboard-only TUI
support is not enough.

### Expected Behavior

The agent API should expose a documented mouse operation. The contract should
decide whether agents send:

- Structured coordinates/buttons/modifiers that the app encodes according to
  the terminal mode, or
- Raw terminal mouse escape sequences, or
- A renderer-mediated mouse event that reuses xterm.js behavior.

The safer long-term direction is structured mouse input because it can be
validated and audited without logging terminal payloads.

### Suggested Implementation Areas

- `docs/specs/components/agent-gateway.md`
- `packages/protocol/src/index.ts`
- `packages/agent-gateway/src/index.ts`
- `apps/desktop/src/main/terminal-command-handler.ts`
- `apps/desktop/src/renderer/terminal-view.tsx`
- `apps/desktop/src/renderer/input-router.ts` if input routing is split there

### Acceptance Criteria

- Mouse-enabled TUI can opt into mouse tracking and receive an agent-generated
  mouse event.
- Invalid coordinates/buttons are rejected before mutation.
- Mouse input is policy-checkable and audited without logging sensitive payloads.
- Headless behavior is documented if mouse input requires renderer state.

### Suggested Tests

- Unit/protocol tests for command validation.
- Integration test with a small PTY program that enables mouse tracking and
  prints received mouse bytes.
- E2E test that uses an actual TUI only if stable and available on CI.

## ACT-004: Agent Lacks First-Class Paste Semantics

### Summary

The agent can send text bytes with `terminal.sendText`, but the gateway has no
first-class paste operation. `terminal.paste` is rejected as `invalid_request`.

### Observed Behavior

The API gap harness sent:

```json
{
  "type": "terminal.paste",
  "payload": {
    "sessionId": "<id>",
    "text": "paste\nblock\n"
  }
}
```

The gateway rejected the command as invalid.

### Why It Matters

Pasting is not always equivalent to typing. Shells and editors can enable
bracketed paste mode to treat pasted blocks safely and differently from
interactive keystrokes. Agents need to paste multi-line content into shells,
REPLs, editors, SSH sessions, and setup prompts without accidentally executing
partial lines in the wrong mode.

### Expected Behavior

Expose a paste operation that preserves paste intent. The implementation should
decide whether it:

- Wraps content in bracketed paste sequences when the terminal has enabled
  bracketed paste, or
- Always uses bracketed paste for paste operations, or
- Lets the caller choose a paste mode.

The behavior must be documented because it affects shells and editors.

### Suggested Implementation Areas

- `docs/specs/components/agent-gateway.md`
- `packages/protocol/src/index.ts`
- `packages/agent-gateway/src/index.ts`
- `apps/desktop/src/main/terminal-command-handler.ts`
- `packages/session-core/src/index.ts`

### Acceptance Criteria

- `terminal.paste` exists and is validated.
- Multi-line pasted text reaches the PTY without being split into separate
  agent commands.
- Bracketed paste behavior is tested and documented.
- Policy/audit can distinguish paste from normal typing without logging pasted
  content.

### Suggested Tests

- PTY test that enables bracketed paste and verifies paste start/end markers.
- Gateway test proving `terminal.paste` is policy-checked as paste input, not
  plain text input.
- Regression test for large paste payload bounds.

## ACT-005: Agent Lacks Explicit Interrupt Command

### Summary

The raw API can interrupt a foreground process by sending Ctrl+C through
`terminal.sendKey`, but there is no semantic `terminal.interrupt` command.

### Observed Behavior

The chaos harness proved Ctrl+C works:

1. Start `sleep`.
2. Send Ctrl+C via `terminal.sendKey`.
3. Observe the foreground process is interrupted.

The API gap harness then sent:

```json
{ "type": "terminal.interrupt", "payload": { "sessionId": "<id>" } }
```

The gateway rejected it as `invalid_request`.

### Why It Matters

Agents should not need to know terminal-control byte details for basic job
control. "Interrupt the foreground task" is an intent-level operation and is
important for stuck commands, watchers, REPLs, and long-running tools.

### Expected Behavior

Expose `terminal.interrupt` as a documented command. The first implementation
can map to Ctrl+C for interactive PTYs. Later implementations may support more
explicit signal semantics where appropriate.

### Suggested Implementation Areas

- `packages/protocol/src/index.ts`
- `packages/agent-gateway/src/index.ts`
- `apps/desktop/src/main/terminal-command-handler.ts`
- `packages/session-core/src/index.ts`

### Acceptance Criteria

- `terminal.interrupt` interrupts a foreground `sleep` or equivalent command.
- Calling interrupt on an exited/missing session returns a typed error.
- The operation is policy-checkable and audited as an interrupt, not raw input.

### Suggested Tests

- Gateway integration test: create session, start `sleep 30`, interrupt, wait
  for prompt or quiet state.
- Unit test for invalid session and policy denial paths.

## ACT-006: Agent Cannot Focus, Select, Or Open Visible Terminal Surfaces

### Summary

The gateway can create and attach to sessions, but it cannot focus a visible
tab, select a session, or request that an existing session be opened/displayed
in a window. `terminal.focus` and `terminal.openWindow` are rejected as
`invalid_request`.

### Observed Behavior

The API gap harness sent:

```json
{ "type": "terminal.focus", "payload": { "sessionId": "<id>" } }
{ "type": "terminal.openWindow", "payload": { "sessionId": "<id>" } }
```

Both were rejected as invalid command payloads.

The current `terminal.attach` behavior grants ownership for the agent
connection. It does not promise to focus the session or change renderer/window
lifecycle state.

### Why It Matters

Mixed human/agent workflows need visible state control. An agent may need to
show a human the session it is operating, focus the tab it needs the human to
inspect, reopen a detached/headless session into a visible terminal, or avoid
typing into the wrong visible surface.

### Expected Behavior

Add explicit display/layout commands with documented contracts:

- Focus/select an existing visible session.
- Open or request a window/tab for an existing session.
- Report whether display is available, created, already visible, or impossible.

This should stay distinct from `terminal.attach`, which is ownership/control
state, not necessarily visual focus.

### Suggested Implementation Areas

- `packages/protocol/src/index.ts`
- `packages/agent-gateway/src/index.ts`
- `apps/desktop/src/main/agent-session-display.ts`
- `apps/desktop/src/main/index.ts`
- `apps/desktop/src/renderer/App.tsx`
- `apps/desktop/src/renderer/terminal-tabs.ts`
- `docs/specs/components/window-manager.md`
- `docs/specs/components/renderer-app-shell.md`

### Acceptance Criteria

- Agent can focus/select a visible session and the renderer reflects the active
  tab change.
- Agent can request display for an existing session.
- Failure modes return typed errors or non-fatal display errors, consistent with
  existing renderer-dependent observation behavior.
- Human tab state and agent display state stay synchronized.

### Suggested Tests

- Renderer/e2e test for focus command changing selected tab.
- Gateway test for open/display command on existing running session.
- Test for destroyed/crashed renderer path returning structured display error.

## ACT-007: Recording Is Not Exposed Through The Public Agent Gateway

### Summary

The application has recorder-related implementation and specs, but the public
agent gateway does not expose recording commands. `terminal.startRecording` and
`terminal.exportRecording` are rejected as `invalid_request`.

### Observed Behavior

The API gap harness sent:

```json
{ "type": "terminal.startRecording", "payload": { "sessionId": "<id>" } }
{ "type": "terminal.exportRecording", "payload": { "sessionId": "<id>" } }
```

Both were rejected as invalid command payloads.

### Why It Matters

Agent observability and auditability are core product goals. If agents can
operate terminals, they also need controlled ways to record, stop, export, and
reference terminal sessions without conflating transcript data with app logs.

### Expected Behavior

Expose recording operations in the agent gateway with explicit policy checks:

- Start recording for a session.
- Stop recording.
- Export recording metadata/events.
- Return typed errors for unavailable or unauthorized recording operations.

Recording payloads must remain distinct from diagnostic logs and should respect
configured redaction.

### Suggested Implementation Areas

- `packages/protocol/src/index.ts`
- `packages/agent-gateway/src/index.ts`
- `packages/recorder/src/index.ts`
- `packages/session-core/src/index.ts`
- `apps/desktop/src/main/terminal-command-handler.ts`
- `docs/specs/components/recorder-transcript-store.md`
- `docs/specs/components/agent-gateway.md`

### Acceptance Criteria

- Agent can start, stop, and export a recording for an owned session.
- Unauthorized or non-owned recording attempts are denied.
- Exported recordings preserve existing schema/redaction guarantees.
- Diagnostic logs do not contain raw terminal transcript data.

### Suggested Tests

- Gateway unit/integration tests for start/stop/export.
- Recorder schema compatibility test through the public gateway.
- Policy denial test for recording operations.

## ACT-008: Kill/Write/Capture/Wait Races Are Underspecified

### Summary

The chaos harness intentionally raced operations against session kill:
write, capture, wait, and kill overlapped. The app did not crash, but the
operation outcomes were mixed.

### Observed Behavior

The raw chaos report recorded:

```text
RACE-001: race kill/write/capture/wait did not crash harness — [false,true,true,false,false]
```

That result is acceptable for a break test, but it is not a clear product
contract.

### Why It Matters

Agents will naturally race terminal lifecycle operations: cancelling commands,
closing sessions, reading output, and waiting for prompts can overlap. If the
contract is unclear, agents cannot build robust retry/error handling around the
terminal API.

### Expected Behavior

Document and test the expected lifecycle boundary. Examples:

- After kill is accepted, new writes must fail with `session_not_running` or
  `session_exiting`.
- Recent output may remain readable for exited sessions until release.
- Screen capture may fail with `observation_unavailable` if no renderer owns the
  session.
- Wait operations should resolve or reject deterministically with typed timeout
  or lifecycle errors.

### Suggested Implementation Areas

- `docs/specs/components/agent-gateway.md`
- `docs/specs/components/terminal-session-manager.md`
- `packages/protocol/src/index.ts`
- `packages/agent-gateway/src/index.ts`
- `packages/session-core/src/index.ts`
- Existing agent gateway and session manager tests.

### Acceptance Criteria

- Spec documents race semantics for kill/write/read/capture/wait.
- Tests cover operations issued before, during, and after kill.
- Errors are typed and stable enough for agents to branch on.
- The app still does not crash under repeated race stress.

### Suggested Tests

- Deterministic unit tests with a fake session manager clock/state machine.
- Integration stress test with bounded retries and explicit timeouts.
- Regression test preserving recent output readability after exit if that is
  the chosen contract.

## ACT-009: Mixed Human/Agent Computer Use Simulation Was Inconclusive

### Summary

Computer Use could inspect the ProContext Terminal UI, including the terminal
input field and tab controls, but direct action calls failed immediately after
successful `get_app_state` calls with:

```text
Computer Use is not active for '<app>'. You first must call `get_app_state`
```

This happened for both the installed packaged app path and the dev Electron app
path.

### Observed Behavior

Working:

- `get_app_state` returned the terminal window, tab group, terminal input field,
  and visible screen.

Not working:

- `type_text`, `click`, `set_value`, and secondary actions refused to bind after
  `get_app_state`.

A macOS accessibility fallback via `osascript` also hung before injecting
keystrokes, so no product pass/fail was claimed for mixed human keystrokes.

### Why It Matters

The product needs mixed human/agent validation. If UI automation cannot drive
human-like keystrokes reliably, we lose an important test path for shared PTY
behavior.

This is not yet proven to be an app bug. It may be a Computer Use/tooling issue,
an app identity ambiguity issue, or an accessibility/focus issue in the terminal
surface.

### Expected Behavior

For testing, there should be a reliable way to simulate human UI input into the
visible terminal while a raw agent client observes and writes to the same PTY.

### Suggested Investigation Areas

- Computer Use app identity selection for duplicate bundle IDs.
- Terminal input field accessibility role/focus behavior.
- Installed app versus repo-packaged app bundle identity.
- Dev Electron app accessibility behavior.
- Existing Playwright/Electron e2e harness as a fallback for human-like input.

### Acceptance Criteria

- A reproducible mixed-control test exists where UI keystrokes and gateway
  writes target the same PTY session.
- The test verifies both human-entered output and agent-entered output through
  the shared observation APIs.
- If Computer Use remains blocked, document the limitation and provide a stable
  alternative harness.

### Suggested Tests

- Use Computer Use if action binding is fixed.
- Otherwise add an Electron e2e test that types through the renderer terminal UI
  and observes through the gateway.

## ACT-010: macOS `open` Launch With Isolated User Data Hung During Test Setup

### Summary

Directly spawning the packaged executable worked for raw API testing. Launching
the repo-packaged `.app` through macOS `open -n ... --args --user-data-dir=...`
created a process but did not produce the expected isolated gateway descriptor.
Logs showed window startup beginning and then renderer unresponsiveness.

### Observed Behavior

The attempted launch shape was:

```bash
open -n "apps/desktop/dist/mac-arm64/ProContext Terminal.app" --args \
  --user-data-dir="$RUN_ROOT/user-data" \
  --remote-debugging-port=0
```

Observed:

- The app process existed with the expected arguments.
- `$RUN_ROOT/user-data/agent-gateway.json` did not appear.
- The log showed `window create_requested`, followed later by a renderer
  unresponsive warning.
- Direct executable launch through
  `Contents/MacOS/ProContext Terminal --user-data-dir=...` worked in the raw
  harness.

### Why It Matters

This may only be a test setup quirk, but packaged macOS launch behavior matters
for realistic user workflows. If one launch path can hang before gateway
startup, agents may not be able to discover/control the app.

### Expected Behavior

Both normal packaged launch paths should either:

- Start the renderer and gateway successfully, or
- Fail with a clear log/error rather than hanging before descriptor creation.

### Suggested Investigation Areas

- `apps/desktop/src/main/index.ts`
- Packaged app resource paths and renderer file loading.
- App single-instance behavior and duplicate bundle IDs.
- macOS `open` argument handling.
- Existing installed app versus repo-packaged app conflicts.

### Acceptance Criteria

- Decide whether this is a supported launch mode.
- If supported, add a packaged smoke test or manual verification note.
- If unsupported, document the supported test launch path and make failures
  easier to diagnose.

### Suggested Tests

- Package smoke test that launches via the supported macOS user launch path.
- Test that descriptor appears under the intended `userData` path.
- Log assertion that startup does not stop after `window create_requested`.

## Known Strong Behaviors From The Break Run

These are not open issues, but future agents should preserve them while fixing
the gaps:

- Unauthenticated and wrong-token clients are rejected.
- Invalid payloads fail before mutation.
- Multiple clients can authenticate at once.
- Agents can attach to a human-created startup session after it exists.
- Eight agent sessions can be created and operated concurrently.
- Concurrent session output stayed isolated.
- Concurrent resize storms did not crash the app.
- Ownership policy blocks non-owner writes until attach.
- Killed sessions reject later input.
- New sessions work after prior agent sessions are killed.
- `less`, `vim`, and `git add -p` can be operated through keyboard input.
- Ctrl+C and Ctrl+D behave cleanly through raw API input.
- Unicode output and large-output tails are preserved in recent output.

## Handoff Rules For Parallel Agents

1. Pick one ACT issue and update its status before starting implementation.
2. Read the relevant accepted spec before changing code.
3. Add or update tests before implementation where practical.
4. Do not weaken existing terminal/PTY behavior to make a new API easier.
5. Keep raw terminal input, PTY output, recordings, and diagnostics separated.
6. When an issue changes public behavior, update the accepted component spec,
   not only this tracker.
