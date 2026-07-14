# Agent Terminal Interface Design

## Status

Accepted target interface.

This document is the authoritative product contract for the agent-facing
terminal interface. Component ownership and implementation sequencing remain
defined by the documents under `docs/specs/`.

The current release implements persistent-session lifecycle, raw input,
canonical observation, shared viewport control, close, recording, and headless
one-shot execution plus automated headless, background, and foreground
presentation. Persistent supported shells also expose trusted integration
capability, current cwd, prompt state, and top-level command lifecycle.

## Purpose

The complete agent interface should be finalized before implementation so the
terminal runtime can be changed once, with coherent package boundaries,
protocol contracts, tests, and migration behavior.

This document is the running source for those decisions. It exists to prevent
the same design questions from being rediscovered as discussion moves between
lifecycle, presentation, interaction, observation, command execution, and
recording.

## Design Principles

- Keep the public agent interface small and intention-oriented.
- Use one raw terminal input stream for every byte sequence a terminal can
  receive.
- Distinguish isolated one-shot execution from intentionally persistent shell
  sessions.
- Keep terminal process lifecycle separate from presentation lifecycle.
- Keep lower-level PTY, process, shell-integration, renderer, and cleanup
  operations internal.
- Do not require agents to coordinate low-level PTY termination with
  session-record disposal.
- Keep current terminal state outside append-only model history.
- Make current screen state replaceable and versioned.
- Let humans and agents operate the same PTY and the same scrollable viewport.
- Keep terminal sessions observable and controllable while headless.
- Do not claim command completion when only screen heuristics are available.
- Keep terminal bytes, screen state, recordings, application diagnostics, and
  agent observations separate.

## Conceptual Model

The implementation has several distinct concerns even when the public
interface composes them.

### Captured operation

An isolated process launched for `terminal.run` with `tty: false`. It uses
ordinary stdin, stdout, and stderr pipes and does not have a terminal screen.

### PTY-backed terminal session

A real pseudoterminal with dimensions, input, output, a canonical terminal
emulator, scrollback, and current screen state.

PTY-backed sessions can be:

- Temporary one-shot sessions created by `terminal.run({ tty: true })`.
- Intentionally persistent interactive shells created by `terminal.create`.

### Terminal presentation

The human-visible renderer tab and desktop window state. Presentation is
independent from whether the PTY is alive and whether the agent can observe its
canonical screen.

### Agent control attachment

The authenticated agent connection's authorization to control and receive
events for an existing PTY-backed terminal session.

### Shell integration

Optional shell-specific instrumentation for persistent interactive shells. It
reports prompt and top-level command lifecycle metadata through invisible,
versioned control sequences in the PTY stream.

Shell integration is not required to execute commands. It adds semantic command
metadata to an otherwise opaque terminal byte stream.

## Expected Public Agent Interface

```ts
terminal.list();
terminal.get({ sessionId });

terminal.run({
  input,
  cwd,
  env,
  shell,
  tty,
  timeoutMs,
  presentation,
});

terminal.create({
  cwd,
  env,
  shell,
  cols,
  rows,
  presentation,
});

terminal.attach({
  sessionId,
  presentation,
});

terminal.input({
  sessionId,
  input,
});

terminal.resize({
  sessionId,
  cols,
  rows,
});

terminal.scroll({
  sessionId,
  scroll,
});

terminal.observe({
  sessionId,
  afterVersion,
  timeoutMs,
});

terminal.observe({
  operationId,
  afterVersion,
  timeoutMs,
});

terminal.setPresentation({
  sessionId,
  presentation,
});

terminal.close({ sessionId });
terminal.close({ operationId });
```

The protocol intentionally exposes no specialized terminal-input or
screen-wait operations. Client SDKs may provide encoding and predicate
helpers, but those helpers must use `terminal.input` and versioned
`terminal.observe`.

## Shared Types

```ts
type SessionId = string;
type OperationId = string;
type TerminalObservationVersion = number;

type TerminalLifecycleState =
  | "creating"
  | "running"
  | "exiting"
  | "exited"
  | "failed";

type TerminalPresentationMode =
  | "headless"
  | "background"
  | "foreground";
```

Branding and runtime validation remain required in the actual protocol.

## One-Shot Execution: `terminal.run`

`terminal.run` executes one supplied shell input in a temporary execution
environment.

```ts
type RunTerminalRequest = {
  input: string;
  cwd?: string;
  env?: Record<string, string>;
  shell?: string;
  tty?: boolean;
  timeoutMs?: number;
  maxOutputBytesPerStream?: number;
  presentation?: TerminalPresentationMode;
};
```

`presentation` applies only when `tty: true`. Captured operations have no
terminal view and must reject non-headless presentation requests.

`tty` defaults to `false`. `timeoutMs` controls how long the initial request
waits for completion and defaults to 10 seconds. It may be set from 1
millisecond through 120 seconds. Reaching this timeout does not terminate the
operation.

`maxOutputBytesPerStream` applies only to `tty: false`. It defaults to 1 MiB
and may be set up to 16 MiB. Supplying it for `tty: true` is invalid because
temporary PTY output uses the fixed terminal-run journal described below.

One-shot PTY runs support omitted, `headless`, `background`, and `foreground`
presentation. Captured runs reject non-headless presentation because they do
not own a terminal view.

The input is a single shell string. Agents can use normal shell syntax:

```ts
await terminal.run({
  input: "pnpm lint && pnpm typecheck && pnpm test",
  cwd: projectPath,
  tty: false,
  timeoutMs: 60_000,
});
```

The agent controls:

- Multiple commands.
- Pipes.
- Redirection.
- Conditional execution.
- Shell builtins.
- Environment changes scoped to that one-shot shell.

### `tty: false`

`tty: false` is the default.

The operation:

- Uses ordinary process pipes.
- Captures stdout and stderr separately.
- Has no terminal screen or viewport.
- Knows completion from the owned process exiting.
- Returns bounded final output once when completed.
- Retains the newest bytes when a stream exceeds its configured limit.

```ts
type CompletedCapturedRun = {
  status: "completed";
  operationId: OperationId;
  tty: false;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
};
```

If the initial timeout expires, the process remains alive unless an explicit
future timeout policy requests termination:

```ts
type RunningCapturedRun = {
  status: "running";
  operationId: OperationId;
  tty: false;
  version: TerminalObservationVersion;
  stdout: string;
  stderr: string;
  truncated: boolean;
  elapsedMs: number;
};
```

The initial running result contains output produced up to that point once.
Later operation observations return only output added after the caller's known
version. Observation versions advance for stdout, stderr, and process
completion. A non-zero process exit is a completed operation, not a protocol
failure. Failure to start the process is a typed request error and does not
create a durable operation.

### `tty: true`

The operation starts a temporary non-persistent shell inside a fresh PTY:

```text
temporary PTY
└── shell -c "<input>"
    └── command processes
```

The operation:

- Has a canonical terminal screen and shared viewport.
- Can be headless, background, or foreground.
- Can accept raw input while it remains alive.
- Knows completion from the owned temporary shell/PTY process exiting.
- Does not require shell-integration markers for completion.
- Does not leave an interactive shell prompt after the one-shot input finishes.
- Retains the newest 1 MiB of combined PTY output for the final result.

```ts
type RunningTerminalRun = {
  status: "running";
  operationId: OperationId;
  sessionId: SessionId;
  tty: true;
  observationVersion: TerminalObservationVersion;
  elapsedMs: number;
};
```

```ts
type CompletedTerminalRun = {
  status: "completed";
  operationId: OperationId;
  sessionId: SessionId;
  tty: true;
  exitCode: number | null;
  signal: string | null;
  output: string;
  truncated: boolean;
  observationVersion: TerminalObservationVersion;
  durationMs: number;
};
```

A successful completion result must be produced only after:

1. The temporary shell/PTY process exits.
2. All preceding PTY output has been received.
3. All output has been committed to the canonical terminal emulator.
4. The final observation version is available.

One-shot completion means the owned foreground execution exited. It does not
promise that intentionally daemonized or backgrounded descendants have stopped.

When the initial request returns a running `tty: true` result, the creating
agent connection automatically controls its `sessionId`. The normal PTY
session operations can then provide input, resize, scrolling, and canonical
screen observation while the command remains alive.

## Persistent Sessions: `terminal.create`

`terminal.create` intentionally creates a persistent interactive shell in a
real PTY.

```ts
type CreateTerminalRequest = {
  cwd?: string;
  shell?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  presentation?: TerminalPresentationMode;
};
```

Persistent sessions are always PTY-backed. They do not need a `tty` parameter.

The creating agent automatically acquires control of the session.

The default presentation for agent-created sessions is `headless`:

```ts
const session = await terminal.create({
  cwd: projectPath,
  presentation: "headless",
});
```

The shell remains alive after each child command finishes:

```text
persistent PTY
└── interactive shell
    ├── first command
    ├── second command
    └── future commands
```

The session ends only when the shell exits or `terminal.close` successfully
terminates and releases it.

## Existing Session Control: `terminal.attach`

`terminal.attach` acquires agent control of an existing PTY-backed session.

```ts
type AttachTerminalRequest = {
  sessionId: SessionId;
  presentation?: TerminalPresentationMode | "unchanged";
};
```

The default is `unchanged`, so attaching to a human session does not
unexpectedly move, focus, hide, or reveal its terminal view.

The name `attach` means agent control attachment. Internal renderer/view
operations must not reuse this name.

## Universal Input: `terminal.input`

All PTY input uses one raw byte-string operation:

```ts
type TerminalInputRequest = {
  sessionId: SessionId;
  input: string;
};
```

Examples:

```ts
await terminal.input({
  sessionId,
  input: "pnpm test\r",
});

await terminal.input({
  sessionId,
  input: "\x03", // Ctrl+C
});

await terminal.input({
  sessionId,
  input: "\x1b", // Escape
});

await terminal.input({
  sessionId,
  input: "\x1b[B", // Arrow down
});
```

The input can contain:

- Shell commands.
- Multiple command submissions.
- Control bytes.
- Terminal escape sequences.
- Paste contents.
- Raw mouse-reporting bytes.
- Input for shells, prompts, REPLs, debuggers, SSH, pagers, editors, and TUIs.

The protocol does not guess whether an input string is a shell command or input
for the currently running application.

Before writing normal user or agent input, the shared viewport returns to the
live bottom so both controllers can see where input is being delivered.

The result remains small:

```ts
type TerminalInputResult = {
  accepted: true;
  observationVersion: TerminalObservationVersion;
};
```

The full terminal state is obtained through the replaceable `terminal.observe`
channel instead of being duplicated in every input result.

## Resize: `terminal.resize`

Resize is not terminal input and remains an explicit operation:

```ts
type ResizeTerminalRequest = {
  sessionId: SessionId;
  cols: number;
  rows: number;
};
```

The PTY and canonical terminal emulator must settle on the same dimensions
before the resulting observation version is committed.

## Observation: `terminal.observe`

`terminal.observe` replaces the broad `wait` and specialized wait-helper
surface.

The requirement is a bounded way to suspend until observable state changes
without busy polling or repeatedly appending unchanged terminal output to model
history.

### Session observation

```ts
type ObserveTerminalRequest = {
  sessionId: SessionId;
  afterVersion?: TerminalObservationVersion;
  timeoutMs: number;
};
```

When `afterVersion` is omitted, the current observation is returned
immediately.

When it is provided, the call waits until:

- The session observation becomes newer.
- The session exits or fails.
- The timeout expires.

Changed result:

```ts
type ChangedTerminalObservationResult = {
  status: "changed";
  observation: TerminalObservation;
};
```

Timeout result:

```ts
type TimedOutTerminalObservationResult = {
  status: "timeout";
  sessionId: SessionId;
  version: TerminalObservationVersion;
};
```

An unchanged timeout does not repeat the viewport.

### Captured-operation observation

`tty: false` operations do not have a terminal screen. The same public
`observe` operation can target their operation ID:

```ts
type ObserveCapturedOperationRequest = {
  operationId: OperationId;
  afterVersion?: TerminalObservationVersion;
  timeoutMs?: number;
};
```

It waits for new stdout, stderr, lifecycle state, or process completion.
`timeoutMs` defaults to 10 seconds and has the same 1 millisecond through
120 second range as `terminal.run`.

Changed output is incremental relative to `afterVersion`:

```ts
type CapturedOperationObservation = {
  operationId: OperationId;
  version: TerminalObservationVersion;
  status: "running" | "completed" | "failed";
  stdout: string;
  stderr: string;
  truncated: boolean;
  exitCode?: number | null;
  signal?: string | null;
};
```

Unchanged timeout result:

```ts
type TimedOutCapturedOperationObservationResult = {
  status: "timeout";
  operationId: OperationId;
  version: TerminalObservationVersion;
};
```

If `terminal.run` completes during its initial asynchronous call, that result
contains the complete bounded output once.

If the initial call times out, its running result contains output produced up
to that version. Every later observation, including the final completed
observation, contains only output added after the caller's `afterVersion`.
Output already returned by an earlier call is never repeated automatically.
If retained bytes needed to satisfy `afterVersion` have already been evicted,
the observation returns the retained tail and sets `truncated: true`.

An operation ID is an unguessable capability. Any authenticated local agent
connection that possesses it may observe or close that operation after a
reconnect. PTY session input and screen observation still require the normal
exclusive session attachment.

## Canonical Terminal Observation

Every PTY-backed session maintains a canonical terminal emulator outside the
visible renderer so observation remains available in headless mode.

```ts
type TerminalObservation = {
  sessionId: SessionId;
  version: TerminalObservationVersion;
  lifecycle: TerminalLifecycleState;
  cwd: string;

  dimensions: {
    rows: number;
    cols: number;
  };

  viewport: {
    rows: TerminalScreenRow[];
    offsetFromBottom: number;
    atTop: boolean;
    atBottom: boolean;
    scrollbackRows: number;
    unseenRows: number;
  };

  cursor: {
    x: number;
    y: number;
    visible: boolean;
  };

  alternateScreen: boolean;
  title: string | null;
  shellIntegration: ShellIntegrationState;
  command: ShellCommandState;
  presentation: TerminalPresentation;
};
```

The observation version increments when any observable field changes,
including:

- Rendered rows.
- Cursor position or visibility.
- Dimensions.
- Shared viewport position.
- Unseen output count.
- Normal/alternate buffer.
- Title.
- Shell-integration state.
- Command state.
- Presentation state.
- Session lifecycle.
- Current integrated working directory.

The agent runtime should replace its previous observation for a session instead
of appending each complete screen to conversation history.

## Viewport

The viewport is the single shared set of terminal rows currently visible to the
human and agent.

```ts
type TerminalScreenRow = {
  row: number;
  text: string;
  wrapped: boolean;
};
```

The viewport:

- Contains the currently displayed terminal grid after ANSI processing.
- Can show the live bottom of the normal buffer.
- Can show historical normal-buffer scrollback.
- Can show the active alternate-screen display.
- Does not contain the complete transcript.
- Does not contain raw ANSI bytes.

Human and agent scrolling update the same canonical viewport position. A
viewport change increments the observation version.

### Viewport metadata

`offsetFromBottom: 0` means the viewport is showing the live bottom.

`atTop` and `atBottom` report navigation boundaries.

`scrollbackRows` reports retained history available for local viewport
navigation.

`unseenRows` counts output added while the viewport is scrolled away from the
bottom.

When new output arrives while scrolled up, the viewport remains anchored to the
same historical content and `unseenRows` increases.

When the viewport is scrolled away from the live cursor, `cursor.visible` is
false.

## Shared Viewport Scrolling: `terminal.scroll`

Scrolling the terminal's local scrollback is presentation/observation control,
not PTY input.

```ts
type TerminalScrollAction =
  | {
      type: "lines";
      delta: number;
    }
  | {
      type: "page";
      direction: "up" | "down";
    }
  | {
      type: "edge";
      edge: "top" | "bottom";
    };

type ScrollTerminalRequest = {
  sessionId: SessionId;
  scroll: TerminalScrollAction;
};
```

Examples:

```ts
await terminal.scroll({
  sessionId,
  scroll: { type: "lines", delta: -10 },
});

await terminal.scroll({
  sessionId,
  scroll: { type: "page", direction: "up" },
});

await terminal.scroll({
  sessionId,
  scroll: { type: "edge", edge: "bottom" },
});
```

The result does not repeat the viewport:

```ts
type ScrollTerminalResult = {
  status: "changed" | "unchanged";
  observationVersion: TerminalObservationVersion;
};
```

When the human scrolls in xterm, the renderer reports the new position to the
canonical viewport controller. When the agent scrolls, the renderer is updated
to show the same position.

Alternate-screen applications commonly have no local scrollback. In that case
`terminal.scroll` returns `unchanged`. Scrolling inside Vim, less, or another
TUI is application input and uses `terminal.input`.

## Alternate-Screen and Cursor Reliability

`alternateScreen` is derived from the canonical terminal emulator's active
buffer and is reliable when PTY output is processed in order.

Rendered viewport rows, wrapping, cursor position, and dimensions are committed
only after the emulator processes the relevant output and resize operations.

Cursor visibility must explicitly track terminal cursor show/hide modes. It
must not be hardcoded.

The terminal observation is reliable terminal-grid state. It does not claim
semantic understanding of arbitrary TUI widgets.

## Shell Integration

Shell integration is added to persistent interactive sessions where the chosen
shell is supported.

It consists of:

- Shell-specific startup scripts and hooks.
- Versioned invisible markers emitted through the PTY.
- A central marker parser.
- Capability negotiation.
- Command and prompt state tracking.
- Per-session nonce validation.

Commands continue working without shell integration. Integration only adds
structured shell metadata.

```ts
type ShellIntegrationState = {
  status:
    | "initializing"
    | "available"
    | "degraded"
    | "unavailable";

  capabilities: {
    prompt: boolean;
    commandStart: boolean;
    commandFinish: boolean;
    commandLine: boolean;
    exitCode: boolean;
    cwd: boolean;
  };
};
```

```ts
type CompletedShellCommand = {
  commandId: string;
  commandLine?: string;
  exitCode: number | null;
  startedAt?: string;
  finishedAt: string;
};

type ShellCommandState =
  | {
      state: "idle";
      lastCommand?: CompletedShellCommand;
    }
  | {
      state: "running";
      commandId: string;
      commandLine?: string;
      startedAt?: string;
    }
  | {
      state: "unknown";
    };
```

Full integration allows ProContext to know when a top-level command submitted
to the persistent shell starts, finishes, and what exit code the shell reports.

This does not provide semantic lifecycle events for:

- Individual actions inside Vim.
- Expressions inside a REPL.
- Debugger commands.
- Commands inside an unintegrated nested or remote shell.
- Background descendants after the shell returns to its prompt.

When integration is unavailable or degraded, the command state must report
`unknown` rather than treating prompt, quietness, or screen text as guaranteed
completion.

## Vim and Other TUIs

### One-shot Vim

```ts
const result = await terminal.run({
  input: "vim README.md",
  tty: true,
  timeoutMs: 1_000,
  presentation: "foreground",
});
```

If Vim remains open, the result contains `operationId` and `sessionId`.

The agent and human interact through the same raw input stream and shared
viewport. Completion is known when Vim exits, the temporary shell exits, and
the PTY exit event is finalized.

### Vim inside a persistent shell

```ts
const session = await terminal.create({
  cwd: projectPath,
  presentation: "background",
});

await terminal.input({
  sessionId: session.sessionId,
  input: "vim README.md\r",
});
```

With shell integration, the top-level `vim README.md` command remains `running`
while Vim owns the terminal. Individual Vim actions do not emit shell command
markers and are understood through raw input plus the shared viewport.

When Vim exits, the shell emits the command-finished marker and returns to
`idle`.

Without shell integration, Vim remains fully usable, but command completion is
not guaranteed. The agent observes the viewport and verifies intended effects
through the filesystem or other relevant APIs.

## Presentation

```ts
type TerminalPresentationMode =
  | "headless"
  | "background"
  | "foreground";
```

### `headless`

- The PTY and canonical terminal emulator remain alive.
- Agent observation remains available.
- No renderer tab is required.

### `background`

- A renderer window and terminal tab exist.
- The shared viewport is visible in xterm.
- The tab does not take focus from the human.

### `foreground`

- A renderer window and terminal tab exist.
- The relevant tab is selected.
- xterm is focused.
- The app attempts to restore, show, and focus the desktop window.
- The result reports the actual settled focus state.

```ts
type TerminalPresentation = {
  state:
    | "headless"
    | "opening"
    | "background"
    | "foreground"
    | "unavailable";
  windowVisible: boolean;
  windowFocused: boolean;
};
```

`terminal.setPresentation` is idempotent:

```ts
type SetTerminalPresentationRequest = {
  sessionId: SessionId;
  presentation: TerminalPresentationMode;
};
```

The initial implementation supports at most one human-visible terminal view per
session. Public renderer, tab, view, and window IDs are not required.

## Session Queries

`terminal.list` and `terminal.get` return canonical lifecycle, shell,
integration, presentation, and latest observation-version metadata.

They do not return the full viewport by default. The full current viewport is
obtained through `terminal.observe`.

Neither operation implicitly acquires control or changes presentation.

## Close

The agent uses one close operation for PTY termination, recording
finalization, and session-record disposal.

For PTY-backed sessions:

```ts
type CloseTerminalRequest = {
  sessionId: SessionId;
};
```

For captured operations:

```ts
type CloseOperationRequest = {
  operationId: OperationId;
};
```

Closing a temporary PTY by either its `operationId` or `sessionId` closes both
records. Closing a captured operation terminates the child if active and
removes the retained operation record after termination succeeds.

Internally, close:

1. Reads the current lifecycle state.
2. Requests termination if still active.
3. Waits for the owned process or PTY to exit with a bounded timeout.
4. Releases records only after exit or failure.
5. Preserves handles and records if termination fails or times out.

```ts
type CloseResult =
  | {
      status: "closed";
      exitCode: number | null;
      signal: string | null;
    }
  | {
      status: "termination_pending";
    };
```

## Internal Operations Hidden From Agents

The implementation still needs lower-level operations:

```ts
spawnCapturedProcess();
spawnTemporaryPtyCommand();
spawnPersistentShell();
writePtyInput();
resizePty();
terminateProcess();
waitForProcessExit();
disposeSessionRecord();
processTerminalOutput();
parseShellIntegrationMarker();
updateCanonicalViewport();
ensureRendererWindow();
openTerminalView();
focusTerminalView();
revealWindow();
closeTerminalView();
```

These remain internal because they cross different boundaries and have
different failure modes.

## Implementation Direction

Implementation follows these ownership boundaries:

- Update the accepted architecture and component specs first.
- Keep `TerminalSessionManager` as the owner of PTY/process lifecycle.
- Add a focused terminal operation manager in `session-core` for one-shot
  lifecycle, output journals, observation, close, and retention.
- Add a captured-process host boundary for `tty: false` one-shot runs.
- Extend the PTY host to launch temporary command shells as well as persistent
  interactive shells.
- Add a canonical terminal emulator outside the visible renderer for every
  PTY-backed session.
- Add a main-process presentation/view manager.
- Add a shared viewport controller synchronized with renderer scrolling.
- Replace renderer-dependent observation with canonical observation.
- Add shell integration as a separate package or focused module with scripts,
  parser, capability state, and tests.
- Commit observation versions only after ordered output processing settles.
- Replace best-effort display with correlated renderer acknowledgements.
- Preserve headless PTY operation and observation when rendering fails.
- Keep shell command lines and terminal content out of diagnostic logs.
- Add tests before implementation for every new public contract.

## Finalized Operational Decisions

### Recording

- Recording remains an explicit advanced capability for PTY-backed sessions.
- The public operations are `terminal.recording.start`,
  `terminal.recording.stop`, and `terminal.recording.export`.
- Recording is off by default and remains policy-controlled.
- Starting and stopping are idempotent.
- Export may snapshot an active recording after pending writes settle.
- `terminal.close` finalizes active recording before releasing the session
  record. If finalization fails, the process remains terminated but the exited
  record is preserved so finalization or export can be retried.
- Captured `tty: false` operations are not transcript recordings; their bounded
  stdout and stderr are operation results.

### Retention and limits

- PTY-backed sessions retain 5,000 rows of normal-buffer scrollback by default.
- Captured runs retain 1 MiB per stdout and stderr stream by default.
- `terminal.run` may request `maxOutputBytesPerStream` up to 16 MiB.
- Captured journals and temporary PTY run journals retain their newest bytes
  when bounded output is exceeded.
- Temporary PTY final results retain the newest 1 MiB of combined PTY output.
- Completed captured operations and completed headless temporary PTY operations
  expire after 10 minutes unless explicitly closed sooner.
- Completed background or foreground temporary PTY views remain as exited
  terminals until the human or agent closes them.
- Active operations and persistent sessions are never evicted by completed
  operation retention.
- Operation IDs are random unguessable capabilities that remain usable by an
  authenticated local agent after its originating connection disconnects.

### Shell integration implementation

- Integration is attempted automatically for supported persistent bash, zsh,
  fish, PowerShell, and Windows PowerShell sessions.
- Normal user startup configuration runs before ProContext installs its hooks.
- Bash uses an injected startup file that sources the normal user startup file
  and then chains prompt and command hooks.
- Zsh uses an isolated startup directory that sources the original startup
  files and installs `preexec` and `precmd` hooks.
- Fish uses its post-configuration initialization command and shell events.
- PowerShell installs prompt and command-line hooks after profiles load.
- Markers use a private, versioned OSC payload with a `PCT` prefix, a
  per-session 128-bit nonce, event kind, command ID, and bounded base64url
  payload.
- Private bootstrap content reads the nonce into non-exported shell state
  without adding it to the shell's inherited environment.
- Unsupported shells report `unavailable`. Partial activation reports
  `degraded`. Hook or marker failure never prevents normal shell use.
- Markers from nested or remote shells without the matching nonce are ignored.
  The parent top-level command remains running until the integrated parent shell
  reports completion.

### Human-agent concurrency

- Human and agent input, resize, scroll, and presentation requests are
  serialized in arrival order per session.
- Shared viewport mutations do not require optimistic version checks. The
  latest settled viewport action wins.
- Normal input returns the shared viewport to the live bottom before bytes are
  written.
- At most one authenticated agent connection controls a session at a time.
  Human interaction remains available concurrently.
- Disconnecting an agent releases its control attachment but does not terminate
  the session.
- Explicit foreground presentation remains policy-checked but does not require
  a modal confirmation in the initial implementation.
- Closing a live human terminal tab requests `terminal.close` through the
  normal confirmation path. Programmatic hiding uses
  `terminal.setPresentation({ presentation: "headless" })`.

These remaining decisions should be resolved here before the full design is
promoted into accepted specs and implemented.
