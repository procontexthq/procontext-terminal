# Shell Integration

## Status

Accepted component architecture.

## Purpose

Shell integration adds trusted prompt, working-directory, and top-level command
lifecycle metadata to persistent interactive shell sessions. It is optional
instrumentation around the real PTY and never replaces terminal input, output,
or lifecycle behavior.

## Supported Sessions

Integration is attempted automatically for persistent Bash, Zsh, Fish,
PowerShell, and Windows PowerShell sessions. Temporary command PTYs, captured
operations, and unsupported shells remain unintegrated.

Normal user startup configuration runs before ProContext installs its hooks:

- Bash uses a private startup file that sources the normal interactive startup
  file before chaining prompt and command hooks.
- Zsh uses an isolated startup directory that forwards normal startup files
  before installing `preexec` and `precmd` hooks.
- Fish installs event handlers through its post-configuration initialization
  command.
- PowerShell dot-sources a generated private bootstrap script after profiles
  load, then installs prompt hooks. The existing prompt script block is
  captured before replacement and invoked once per prompt; chaining must not
  resolve the replacement recursively. The prompt hook installs or re-chains
  PSReadLine command validation after the interactive shell has initialized it.
  Standard PSReadLine `AcceptLine` bindings are upgraded to
  `ValidateAndAcceptLine` so validation runs before the command is accepted.
  Custom key handlers are not overwritten.

Hook failure must not prevent the shell from starting or accepting input.
Generated Bash and Zsh references to user startup files retain POSIX path
syntax even when deterministic bootstrap tests run on Windows.

## Marker Protocol

Hooks emit private OSC 633 markers:

```text
OSC 633 ; PCT;1;<nonce>;<event>;<command-id>;<base64url-payload> ST
```

The event is `ready`, `prompt`, `command-start`, or `command-finish`. Each
persistent supported session owns a random 128-bit nonce. Private startup
content copies the nonce into non-exported shell state without adding it to the
shell's inherited environment.

Limits are:

- 64 KiB encoded marker.
- 32 KiB decoded command line.
- 4 KiB decoded working directory.
- 64 ASCII characters for a command ID.

Markers with another prefix, protocol version, or nonce are ignored. A malformed
marker with the matching nonce degrades integration and resets command state to
`unknown`.

## State Contract

Supported sessions begin as `initializing`. A valid full-capability `ready`
marker changes the state to `available`. Partial activation or a ten-second
initialization timeout changes it to `degraded`; a later valid marker may
recover the session. Unsupported shells report `unavailable`.

PowerShell attempts to import PSReadLine, install the ProContext validation
handler, and establish a validation-aware accept binding during bootstrap and
again at each prompt before emitting its capability marker. Full capabilities
are advertised only after the handler and accepting binding are both active.
When a custom binding prevents safe activation, prompt and cwd capabilities
remain available without trusted command lifecycle. This allows delayed
PSReadLine initialization, interactive startup reconfiguration, and a lost
startup marker to recover without a protocol acknowledgement.

While integration is `degraded` or `unavailable`, command state is `unknown`.
For available integration:

- `prompt` updates the current working directory and sets command state to
  `idle`.
- `command-start` sets command state to `running`.
- A matching `command-finish` records the exit code and returns to `idle`.
- Shell exit before a matching finish resets a running command to `unknown`.

Command timestamps use host receipt time. Unix shells report their native
status. PowerShell reports native process exit status where applicable and
maps cmdlet success or failure to `0` or `1`.

## Security And Diagnostics

- Nested or remote markers without the session nonce cannot mutate state.
- Nonces, marker payloads, command lines, terminal contents, and environment
  values are never written to application diagnostics.
- Generated startup files use private permissions and are removed after spawn
  failure or session disposal.
- Raw PTY behavior, renderer presentation, recording, and agent attachment
  remain independent from integration availability.

## Testing Expectations

- Shell detection and launch rewriting preserve normal startup behavior.
- Marker parsing validates version, nonce, event shape, encoding, and limits.
- Capability, prompt, cwd, command start, command finish, timeout, recovery, and
  shell-exit transitions are deterministic.
- Unsupported, nested, remote, malformed, and temporary-shell cases cannot
  produce trusted command state.
- Real PTY tests cover each installed supported shell, including PowerShell
  Core on every CI platform where it is installed, with deterministic
  bootstrap tests for shells unavailable on the current platform. These tests
  use the production ten-second initialization contract and event-driven,
  bounded waits for eventual negotiation and command completion; they do not
  impose a stricter shell-startup performance requirement.
- PowerShell launch tests verify generated bootstrap cleanup and repeated
  capability advertisement. They also verify that the previous prompt cannot
  recurse through the replacement and that command validation has an active
  accept binding before full capabilities are advertised.
- Real-shell cwd assertions compare canonical filesystem identity so Windows
  short and long path spellings are treated as the same directory.
