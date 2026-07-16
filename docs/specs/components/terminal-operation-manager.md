# Terminal Operation Manager

## Status

Accepted component architecture for Phase 2.

## Purpose

The terminal operation manager owns one-shot execution records. It presents one
domain boundary over captured child processes and temporary PTY command
sessions without duplicating persistent-session behavior.

## Responsibilities

- Start one-shot execution from a single shell input string.
- Route `tty: false` requests to the captured-process host.
- Route `tty: true` requests to a temporary command session owned by the
  terminal session manager.
- Assign unguessable operation IDs.
- Retain bounded tail output and versioned incremental observations.
- Wait for initial completion for the requested timeout without killing a
  still-running operation.
- Close active operations and remove successfully closed records.
- Expire completed captured and headless temporary PTY operations after 10
  minutes.
- Keep operation and temporary-session records consistent when either identity
  is closed.
- Notify the composing runtime whenever an operation record is removed so
  transport-specific ownership indexes can discard the same capability.

## Captured Operations

Captured operations retain stdout and stderr independently. Each stream defaults
to 1 MiB and may be configured per request up to 16 MiB. The journal retains
the newest bytes when bounded capacity is exceeded.

Observation versions advance when stdout arrives, stderr arrives, or lifecycle
completion is committed. Incremental observations return only data newer than
the requested version when it remains retained. They return the retained tail
with `truncated: true` when required earlier bytes have been evicted.

Process spawn failure is a typed request failure and does not leave an operation
record. Any process exit after successful spawn, including a non-zero exit, is
a completed operation.

## Temporary PTY Operations

Temporary PTY commands reuse the session manager's PTY lifecycle, canonical
model, input, resize, scroll, observation, recording, and close behavior. They
add only:

- A non-interactive command-shell launch.
- An operation-to-session identity mapping.
- A fixed 1 MiB tail journal of combined raw PTY output.
- Completion after process exit and canonical model settlement.

Temporary PTY operations may be headless, background, or foreground. The
operation manager reports the new session through a narrow creation callback so
Electron main can settle presentation before the initial run wait completes.
Completed headless temporary operations expire after retention. A failed or
unavailable presentation follows the same expiry rule because it has no usable
view. Completed operations with an opening, background, or foreground view
remain until explicit close.

## Ownership And Reconnect

Operation IDs are random capabilities. Authenticated local agent connections
that possess an operation ID may observe or close it after reconnecting.
Temporary PTY session interaction still requires exclusive attachment to the
session ID. The creating connection receives that attachment automatically.

## Boundaries

The operation manager must not:

- Spawn child processes or node-pty directly.
- Parse agent transport messages.
- Own agent connection attachment state.
- Import Electron or renderer code.
- Treat bounded operation output as an explicit terminal recording.

## Testing Expectations

- Captured stdout and stderr remain separate and ordered within each stream.
- Initial completion and timeout results use the documented defaults.
- Output limits retain tails and report truncation.
- Incremental observation does not repeat previously returned output.
- Exit completion advances the version after final output.
- Temporary PTY completion waits for canonical model settlement.
- Close terminates active work and removes only successfully closed records.
- Completed records expire while active operations do not.
- Spawn failure leaves no durable operation.
