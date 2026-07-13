# Project Structure

## Status

Living document. Update this file whenever folders, packages, module ownership, or delegation boundaries change.

## Purpose

This document explains the repository structure at a high level. It should help contributors and coding agents quickly understand where a change belongs, which module owns which responsibility, and how work can be split into small independent tasks.

The architecture source of truth is [Terminal Architecture Spec](./specs/terminal-architecture.md). This file is the practical map of how that architecture is arranged in the repository.

## Structure Principles

- Each folder should have a clear owner concern.
- Shared packages should expose narrow, typed contracts.
- App-specific code should stay inside `apps/desktop`.
- Cross-process protocol types should stay in `packages/protocol`.
- Native PTY code should stay isolated from renderer code.
- Renderer UI should not import main-process modules.
- Files should generally stay under `300` lines and remain focused on one concern.
- If a module grows beyond its concern, split it into smaller files or a dedicated package.

## Target Repository Tree

```text
.
|-- AGENTS.md
|-- AGENTS.local.md
|-- CHANGELOG.md
|-- .nvmrc
|-- package.json
|-- pnpm-lock.yaml
|-- pnpm-workspace.yaml
|-- scripts/
|-- tsconfig.base.json
|-- apps/
|   `-- desktop/
|       |-- package.json
|       |-- electron-builder.yml
|       |-- scripts/
|       |-- src/
|       |   |-- main/
|       |   |-- preload/
|       |   `-- renderer/
|       `-- tests/
|-- packages/
|   |-- protocol/
|   |-- pty-host/
|   |-- session-core/
|   |-- agent-gateway/
|   |-- recorder/
|   |-- terminal-observer/
|   |-- config/
|   `-- test-fixtures/
|-- docs/
|   |-- development/
|   |-- project-structure.md
|   `-- specs/
|       |-- implementation-plan.md
|       |-- terminal-architecture.md
|       `-- components/
|           `-- README.md
`-- .agents/
    |-- rules/
    `-- skills/
```

Not every folder exists at the beginning of the project. When implementation creates or removes a folder, update this document in the same change.

## Architecture Component Mapping

The architecture specs describe components. The repository structure groups some of those components into broader packages or app folders so package boundaries stay practical.

| Architecture component | Primary repository location |
| --- | --- |
| Electron main process | `apps/desktop/src/main` |
| Window manager | `apps/desktop/src/main` |
| Preload bridge | `apps/desktop/src/preload` |
| Renderer app shell | `apps/desktop/src/renderer` |
| Terminal view | `apps/desktop/src/renderer` |
| Terminal input | Raw input types in `packages/protocol`; ordered PTY writes in `packages/session-core` |
| Terminal session manager | `packages/session-core` |
| Terminal operation manager | `packages/session-core` |
| Captured process host | `packages/session-core` |
| PTY host | `packages/pty-host` |
| Shell resolver | `packages/pty-host` |
| Agent gateway | `packages/agent-gateway` |
| Policy engine | `packages/policy-engine` |
| Canonical observation | Headless xterm model in `packages/session-core`; renderer xterm is a projection |
| Recorder and transcript store | `packages/recorder` |
| Settings store | `packages/config` |
| App logger | `apps/desktop/src/main` unless shared logging warrants a dedicated package |

## Root Files

### `AGENTS.md`

Public contributor and coding-agent instructions. This file defines repository etiquette, architecture expectations, commands, testing requirements, and coding conventions.

Update this file when a rule applies broadly to future contributors and cannot be inferred from code.

### `AGENTS.local.md`

Private local guidance. This file is not intended for the public repository.

Do not place public architecture, commands, or coding rules here.

### `CHANGELOG.md`

User-facing release history in Keep a Changelog format.

Update through the `/changelog-release` skill once release automation exists.

### `package.json`

Root workspace manifest.

Expected responsibilities:

- Define top-level scripts such as `dev`, `lint`, `format`, `typecheck`, `test`, `test:e2e`, and `build`.
- Define package manager metadata.
- Define the supported Node.js major through `engines`; `.nvmrc` should match this value.
- Keep workspace orchestration at the root, not app-specific implementation.

### `.nvmrc`

Node.js version hint for local development.

Expected responsibilities:

- Pin the supported Node.js major used by the workspace.
- Match the root `package.json` `engines.node` range.

### `scripts`

Root workspace setup and validation scripts.

Expected responsibilities:

- Check supported Node.js versions before install-time native dependency work.
- Provide platform bootstrap helpers such as Linux Electron runtime setup.
- Keep scripts portable and documented from README or `docs/development`.

### `pnpm-workspace.yaml`

Workspace package registration.

Expected responsibilities:

- Include `apps/*`.
- Include `packages/*`.
- Avoid one-off package paths unless there is a clear reason.

### `tsconfig.base.json`

Shared TypeScript configuration.

Expected responsibilities:

- Enforce strict TypeScript defaults.
- Provide common compiler options.
- Avoid app-specific path assumptions unless they are shared across the whole workspace.

## `apps/desktop`

The Electron desktop application. This is the only package that owns desktop windows, renderer UI, preload exposure, app packaging, and Electron app lifecycle.

### `apps/desktop/scripts`

Desktop application packaging, install verification, and release helper scripts.

Responsibilities:

- Verify Electron and package output before app startup or packaging tests.
- Keep app-specific packaging checks outside root workspace setup scripts.
- Provide clear remediation when native desktop dependencies are missing.

### `apps/desktop/src/main`

Electron main-process code.

Responsibilities:

- Start the Electron app.
- Create and manage desktop windows.
- Register IPC handlers.
- Wire session manager, PTY host, settings, policy, recorder, logger, and agent gateway.
- Adapt session and operation managers to the narrow agent service in a focused
  main-process module.
- Own app lifecycle and graceful shutdown.
- Own native OS integration.
- Persist structured app diagnostics through the main-process logger.

Must not:

- Render UI.
- Contain xterm.js UI logic.
- Expose broad native APIs to the renderer.
- Mix terminal output with application logs.
- Log PTY bytes, terminal input, clipboard contents, transcript data, or full environment values by default.

Packaging note:

- `apps/desktop/package.json` may declare native runtime dependencies such as `node-pty` so bundled Electron main code can resolve them from the app package on macOS, Windows, and Linux. Application code must still import `node-pty` only through `packages/pty-host`.
- `apps/desktop/electron-builder.yml` owns distributable artifact configuration. Packaging verification helpers live under `apps/desktop/scripts`.
- `apps/desktop/resources` owns native desktop app assets such as macOS,
  Windows, and Linux app icons. Renderer UI assets remain under
  `apps/desktop/src/renderer`.

Good delegation tasks:

- Implement window lifecycle.
- Add IPC handler for one terminal operation.
- Wire a new main-process service.
- Add app shutdown/session cleanup behavior.

### `apps/desktop/src/preload`

Secure bridge between renderer code and the main process.

Responsibilities:

- Expose `window.terminalApi`.
- Hide raw Electron IPC from renderer code.
- Provide typed request/response helpers.
- Provide subscription cleanup for terminal events.

Must not:

- Spawn processes.
- Store business logic.
- Implement UI state.

Good delegation tasks:

- Add one typed preload method.
- Add runtime validation around a renderer request.
- Improve subscription cleanup behavior.

### `apps/desktop/src/shared`

Desktop-app-only helpers shared by main, preload, and renderer code.

Responsibilities:

- Hold pure platform or UI helper logic that needs to be used by more than one
  desktop process.
- Avoid Electron, DOM, xterm.js, React, and node-pty imports.

Good delegation tasks:

- Add a pure keyboard shortcut resolver shared by main and renderer.

### `apps/desktop/src/renderer`

Human-facing UI.

Responsibilities:

- Render the app shell.
- Render terminal views through xterm.js.
- Manage tabs, panes, status UI, settings UI, and command palette.
- Capture keyboard, paste, selection, focus, resize, and mouse interactions.
- Bootstrap from canonical serialized terminal state and report human viewport
  movement.

Must not:

- Import node-pty.
- Spawn shells or child processes.
- Import main-process modules.
- Treat UI state as canonical terminal lifecycle state.

Good delegation tasks:

- Build the terminal view component.
- Add resize handling.
- Add tab or pane UI.
- Add search/copy/paste UI.
- Add agent activity indicator UI.

### `apps/desktop/tests`

Desktop app tests.

Responsibilities:

- Exercise Electron app workflows.
- Verify renderer/main/preload integration.
- Test visible terminal behavior through the app surface.

Good delegation tasks:

- Add an E2E test for creating a terminal.
- Add a copy/paste workflow test.
- Add a resize propagation test.

## `packages/protocol`

Shared TypeScript contracts used across main, preload, renderer, agent gateway, tests, and shared packages.

Responsibilities:

- Define branded IDs such as `SessionId` and `RequestId`.
- Define IPC command/event types.
- Define agent command/event types.
- Define terminal session snapshots.
- Define screen snapshot types.
- Define domain error types.
- Define Zod schemas or equivalent runtime validators.

Must not:

- Import Electron.
- Import node-pty.
- Import renderer UI code.
- Contain side effects.

Good delegation tasks:

- Add a new protocol message.
- Add validation schema for a payload.
- Add a domain error type.
- Add protocol serialization tests.

## `packages/pty-host`

Adapter around node-pty and shell resolution.

Responsibilities:

- Import node-pty.
- Spawn PTY sessions.
- Write PTY input.
- Resize PTY sessions.
- Receive PTY output and exit events.
- Resolve default shell and configured shell profiles.
- Normalize platform-specific PTY behavior.
- Convert infrastructure errors into protocol/domain errors.

Must not:

- Know about renderer UI.
- Expose node-pty types across package boundaries.
- Own session lifecycle policy.
- Own agent authentication.

Good delegation tasks:

- Implement shell resolver for one platform.
- Add PTY spawn failure mapping.
- Add resize behavior.
- Add tests around PTY output and exit events.

## `packages/session-core`

Core terminal session domain logic.

Responsibilities:

- Create, track, and dispose terminal sessions.
- Create, track, observe, retain, and dispose one-shot operations.
- Own canonical session lifecycle state.
- Own one headless xterm model and ordered output queue per PTY.
- Route raw input, resize, and shared viewport operations.
- Provide versioned observation and serialized renderer bootstrap.
- Coordinate explicit recording lifecycle and close finalization.
- Broadcast sequenced renderer projection events.
- Host captured child processes behind a focused internal boundary.
- Maintain separate bounded stdout/stderr journals for captured operations and
  a combined bounded output journal for temporary PTY results.
- Map temporary operation IDs to PTY session IDs without duplicating session
  interaction logic.

Must not:

- Import renderer UI.
- Import Electron windows directly.
- Expose raw node-pty handles.
- Enforce actor authorization or agent attachment.
- Implement transport-specific agent gateway behavior.

Good delegation tasks:

- Implement session state machine.
- Add session lifecycle events.
- Add session metadata handling.
- Add session manager tests for one operation.
- Add operation manager tests for captured or temporary-PTY execution.

## `packages/agent-gateway`

Local control gateway for autonomous coding agents.

Responsibilities:

- Accept local agent connections.
- Authenticate callers.
- Validate agent commands.
- Authorize operations through the policy engine.
- Translate agent commands into session-core operations.
- Enforce one controlling agent connection per session.
- Return request/response results and cancellable long-poll observations.
- Emit audit events.

Must not:

- Spawn PTYs directly.
- Bypass session-core.
- Trust external messages without validation.
- Bind unauthenticated network control by default.

Good delegation tasks:

- Add one agent command handler.
- Add local WebSocket connection lifecycle.
- Add a new gateway command category.
- Add transport-level regression tests.

## `packages/recorder`

Transcript and replay event storage.

Responsibilities:

- Record session lifecycle events.
- Record PTY output chunks.
- Record terminal input events with origin.
- Record resize and exit events.
- Store append-only, versioned recording data.
- Apply redaction and recording policy.
- Export replay metadata.

Must not:

- Log application diagnostics.
- Decide whether an agent may control a session.
- Mutate terminal state.

Good delegation tasks:

- Define recording event format.
- Add append-only writer.
- Add recording export.
- Add redaction tests.

## Canonical Observation

Canonical observation remains inside `packages/session-core` because it is part
of every session record and depends directly on ordered output and lifecycle
processing. Do not add a separate observer package unless a later concrete
reuse boundary requires one.

## `packages/config`

Settings, platform paths, and migrations.

Responsibilities:

- Define settings schemas.
- Load and validate settings.
- Write settings safely.
- Migrate settings between schema versions.
- Resolve app data, logs, recordings, and settings paths through platform-aware APIs.

Must not:

- Hardcode Unix-only paths.
- Import renderer UI.
- Import node-pty unless a shell profile schema explicitly requires a shared type.

Good delegation tasks:

- Add settings schema.
- Add migration helper.
- Add platform path resolver.
- Add invalid-settings fallback tests.

## `packages/test-fixtures`

Deterministic helpers for tests.

Responsibilities:

- Provide shell scripts or small programs for PTY tests.
- Provide deterministic TUI-like fixtures.
- Provide replay files.
- Provide test-only utilities shared by packages.

Must not:

- Leak into production code.
- Become a dumping ground for unrelated test helpers.

Good delegation tasks:

- Add a deterministic echo fixture.
- Add an alternate-screen fixture.
- Add a long-output fixture.

## `docs`

Project documentation.

Responsibilities:

- Keep architecture and structure current.
- Explain decisions that are not obvious from code.
- Provide specs for major features.

### `docs/specs`

Authoritative design specs.

Responsibilities:

- Define stable architectural and feature decisions.
- Document behavior before or alongside implementation.
- Describe contracts, constraints, and rationale.
- Keep component specs small enough that each major component has a clear owner document.

Current specs:

- [Terminal Architecture Spec](./specs/terminal-architecture.md) - master architecture entry point and system-level cross-cutting contracts.
- [Implementation and Testing Plan](./specs/implementation-plan.md) - phased implementation sequence, testing plan, exit criteria, and release verification checks.
- [Component Specs](./specs/components/README.md) - detailed specs for individual architecture components such as the Electron main process, preload bridge, terminal view, session manager, PTY host, agent gateway, policy engine, screen observer, recorder, settings store, and app logger.

## `.agents`

Local agent guidance and reusable skills.

Responsibilities:

- Store coding-agent rules.
- Store project-specific skills.
- Keep instructions aligned with public guidance in `AGENTS.md`.

## Delegation Guide

Use this structure to delegate small independent tasks:

- Protocol work belongs in `packages/protocol`.
- PTY and shell behavior belongs in `packages/pty-host`.
- Session lifecycle belongs in `packages/session-core`.
- Agent API behavior belongs in `packages/agent-gateway`.
- UI components belong in `apps/desktop/src/renderer`.
- Electron app wiring belongs in `apps/desktop/src/main`.
- Preload API exposure belongs in `apps/desktop/src/preload`.
- Recording and replay belongs in `packages/recorder`.
- Canonical viewport and versioned observation belong in
  `packages/session-core`.
- Settings and migrations belong in `packages/config`.
- Cross-package tests and fixtures belong in `packages/test-fixtures`.

When delegating work, assign ownership by folder or package and avoid overlapping write scopes.

## Update Rules

Update this file when:

- A new folder or package is added.
- A package responsibility changes.
- A module boundary changes.
- A dependency direction changes.
- A new class of delegation task becomes common.
- A folder is renamed, removed, or split.

Do not update this file for every small implementation detail. Keep it focused on structure, ownership, and module responsibilities.
