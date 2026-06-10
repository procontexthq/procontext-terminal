# ProContext Terminal

A standalone desktop terminal for human and agent workflows.

ProContext Terminal is a TypeScript-first Electron application built around real
pseudoterminal sessions. The current foundation focuses on being a reliable,
plain terminal: secure Electron process separation, xterm.js rendering,
node-pty-backed shells, typed IPC, persisted settings, and end-to-end smoke
coverage.

## Status

Phase 2 is complete: tabs, workspace restore, internal agent-useful terminal
observation, waits, detach/attach, recording export, and cross-platform CI are
implemented on top of the PTY-backed desktop terminal.

Phase 3 is complete: authenticated loopback WebSocket access, explicit policy
decisions, audit events, descriptor discovery, and visible agent activity are
implemented and covered by local and CI checks. Later phases add human terminal
UX polish and packaging.

## Architecture

- Electron main process owns native capabilities and PTY lifecycle.
- The renderer stays sandboxed and talks through a minimal preload API.
- xterm.js owns terminal rendering, input capture, scrollback, and resize.
- node-pty provides real local shells and interactive process behavior.
- Shared TypeScript packages define protocol, config, PTY, and session
  boundaries.

The detailed design lives in [`docs/specs`](docs/specs).

## Development

Requirements:

- Node.js 24
- pnpm `10.28.2`

```bash
nvm use
pnpm install
pnpm dev
```

Linux development machines need Electron runtime libraries in addition to
JavaScript dependencies. On Ubuntu/Debian, run the bootstrap script before
starting the app:

```bash
pnpm setup:linux
```

For SSH or other headless Linux sessions, use the Xvfb-backed dev command:

```bash
pnpm dev:linux:headless
```

See [`docs/development/linux.md`](docs/development/linux.md) for the required
apt packages, headless behavior, and Electron install troubleshooting.

To verify that Electron's downloaded binary is present:

```bash
pnpm electron:verify
```

Useful checks:

```bash
pnpm lint
pnpm format
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
```

Packaging and release-hardening checks:

```bash
pnpm package:current
pnpm package:verify
pnpm test:package
```

`package:current` builds the unpacked packaged app for the current OS. Platform
release artifacts are built on matching CI runners through `package:mac`,
`package:linux`, and `package:win`.

Development logs are mirrored to stderr and app diagnostics persist as JSONL in
`main.log` under the platform Electron logs directory. Terminal PTY output and
input are not written to app logs by default.

## Repository Layout

```text
apps/desktop        Electron desktop app
packages/protocol   Shared IPC, event, config, and error contracts
packages/pty-host   node-pty adapter and shell resolution
packages/session-core
                    Terminal session lifecycle and routing
packages/config     Versioned settings parsing and persistence
docs/specs          Architecture and implementation specs
```

## License

License information has not been published yet.
