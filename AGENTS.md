# Development Guidelines

This document contains critical information about working with this codebase. Follow these guidelines precisely.

## About the Project

This project is a standalone desktop terminal for autonomous coding agents. The initial goal is to replicate a reliable, plain terminal similar to the integrated terminal in VS Code. From that base, the project will add agent-specific control and observability features so an agent can spawn terminal sessions, operate them like a human, and eventually work inside TUIs.

The project is TypeScript-first. The expected desktop stack is Electron for the application shell, xterm.js for terminal rendering, node-pty for real pseudoterminal sessions, and typed IPC/protocol packages for communication between the UI, PTY host, and agent-facing APIs.

## Project Motivation

Autonomous coding agents need a terminal they can use safely and accurately. A plain command runner is not enough: real development workflows involve shells, prompts, interactive commands, pagers, editors, test watchers, and TUIs such as `vim`, `less`, `top`, and `git add -p`. This project exists to provide a terminal surface that is useful for both humans and agents, while preserving the behavior of a real local terminal.

## Critical Git Operations Policy

**NEVER commit and push changes without explicit user approval.**

You must:

1. Wait for the user to explicitly ask you to commit and push any documentation or code changes.
2. If you believe a commit is necessary, say "I think we should commit these changes. Should I commit and push them?" and wait for the user's response.
3. Never mention `co-authored-by` or similar commit metadata. In particular, never mention the tool used to create the commit message or PR.
4. **Commit by intent.** If something is a coherent unit, such as a feature, fix, refactor, or doc update, it deserves its own commit. Avoid one giant commit for unrelated work and avoid a commit for every tiny edit.
5. Make a branch for features, refactors, experiments, migrations, or anything that may take more than one sitting.
6. Commit only the changes relevant to the current session. If there are other pending changes, ask the user whether you should commit them as well.
7. **Run all relevant checks before pushing.** Once the TypeScript project is scaffolded, the expected checks are:
   ```bash
   pnpm lint
   pnpm format
   pnpm typecheck
   pnpm test
   pnpm test:e2e
   pnpm build
   ```
8. **Never merge branches locally into main.** Always push the branch to remote and create a pull request via `gh pr create`. This ensures CI runs on the PR and changes are reviewed before merging.

## Specifications

Spec documents are in `docs/specs/`. Read the relevant spec before making changes. These are the authoritative design documents for this repo.

**Document everything.** Follow a document-first approach. Every feature, design decision, and architectural choice should be reflected in the specs before or alongside implementation. This ensures the rationale behind decisions is clear and future contributors can understand the context without reverse-engineering it from code.

`docs/project-structure.md` is the living map of repository modules, ownership boundaries, and delegation scopes. Keep it updated whenever folders, packages, or module responsibilities change so future work can be split cleanly across contributors or agents.

You are allowed to create new documents if the discussion warrants it.

## Commands

The repository may not always have implementation scaffolding checked in yet. Once the TypeScript workspace exists, use the package manager declared by the lockfile. The default for this project is `pnpm`.

```bash
# Install dependencies
pnpm install

# Run the desktop app in development mode
pnpm dev

# Run lint checks
pnpm lint

# Format code
pnpm format

# Type check all TypeScript packages
pnpm typecheck

# Run unit/integration tests
pnpm test

# Run end-to-end UI tests
pnpm test:e2e

# Build distributable app artifacts
pnpm build
```

If a command is not yet available, inspect `package.json` scripts and use the closest project-defined command instead of inventing one.

## Architecture

**Electron main process owns native capabilities.** The main process creates PTY sessions, manages process lifecycle, owns OS integration, and exposes a narrow typed IPC surface. Renderer code must not spawn processes directly.

**xterm.js renders terminal state.** The renderer process uses xterm.js for ANSI parsing, cursor rendering, selection, scrollback, alternate screen behavior, mouse handling, themes, and terminal viewport layout.

**node-pty provides real pseudoterminals.** Shells and interactive programs must run inside a PTY, not a plain `child_process` pipe. This is required for correct behavior with shells, prompts, curses apps, editors, pagers, and cross-platform terminal semantics.

**Typed IPC is the internal contract.** Renderer-to-main communication must go through a narrow, typed API for operations such as `createSession`, `write`, `resize`, `kill`, and lifecycle/output subscriptions. Do not expose unrestricted Node.js APIs to the renderer.

**Agent control is a first-class API, not a testing hack.** Agent-facing operations should be modeled explicitly: create a terminal, send text, send keys, resize, read recent output, read the visible viewport, capture a screen snapshot, wait for text/screen changes, and terminate sessions.

**Human and agent control share the same PTY session.** The agent should operate the real terminal surface, not a separate fake command runner. Agent-specific observability can be added around the terminal, but behavior must remain faithful to a normal terminal.

## Coding Conventions

**TypeScript**

- Use TypeScript for application code, shared protocol definitions, and tests.
- Keep `strict` TypeScript enabled. Do not weaken type checking to work around design issues.
- Avoid `any`. Use `unknown` at boundaries and narrow it deliberately.
- Model protocol messages, terminal events, and domain errors with discriminated unions.
- Keep shared protocol types in a dedicated package or module so main, renderer, and tests use the same contracts.

**Imports**

- Keep imports at the top of the file.
- Use type-only imports with `import type` when a dependency is only used as a type.
- Avoid dynamic imports unless they are necessary for optional, platform-specific, or lazy-loaded code. Add a short comment when using one.

**Segregation of concerns**

- Each file should own one specific concern. If a file starts handling multiple unrelated responsibilities, split it into focused files or move the concern into the appropriate package.
- Prefer files under `300` lines. A file can grow up to `500` lines only when the code is still strongly cohesive and splitting it would make the design harder to follow.
- Do not create functions just for the sake of creating functions. Not every block of code deserves extraction.
- When a piece of logic is genuinely reusable, independently testable, complex enough to name clearly, or important enough to isolate, create a function for it.
- Functions should exist because they improve clarity, reuse, testability, or boundary design, not because of arbitrary line-count rules.

**Logging**

- Use the project logging abstraction for desktop app diagnostics. Do not write directly to stdout from long-running terminal internals unless the output is intentionally part of a child PTY stream.
- App logs are structured JSONL diagnostics. In development they also go to stderr for immediate feedback; they persist under Electron's `app.getPath("logs")` path as `main.log`.
- Include enough structured context to trace failures: component, event, request ID when available, session ID when available, and typed error information. Do not rely on prose-only error strings.
- Keep logging production-grade and proportional. Log meaningful lifecycle boundaries, policy decisions, and failures; avoid noisy success-path, per-byte, per-keystroke, polling-loop, or high-frequency hot-path logs unless there is a temporary, documented debugging reason.
- Never log PTY output, terminal input, clipboard contents, full environment values, secrets, tokens, cookies, credentials, or transcript data by default.
- Keep terminal transcript data, app diagnostics, and agent observations distinct.

**Platform-aware paths**

- Do not hardcode OS-specific config, data, or cache directories.
- Use Electron app path APIs or a small platform-path abstraction for user data, logs, session recordings, and settings.
- Always account for macOS, Windows, and Linux path behavior.

**Security**

- Keep Electron renderer processes sandboxed where possible.
- Disable direct Node.js access in renderer windows unless there is a documented reason.
- Expose native capabilities through a preload bridge with a minimal, typed surface.
- Treat agent access to terminals as sensitive. Agent APIs must be auditable and eventually permissioned.

## Non-obvious Coding Guidelines

This project follows a set of non-obvious coding guidelines. Apply them when writing or reviewing any code in this repo.

See [`.agents/rules/coding-guidelines.md`](.agents/rules/coding-guidelines.md) for the full list.

## Changelog Maintenance

`CHANGELOG.md` is maintained via the `/changelog-release` skill. Use it before committing to populate `[Unreleased]`, or with a version number to finalize a release section.

## Testing Requirements

- Write tests before generating implementation code.
- Tests should cover expected behavior, edge cases, and error conditions.
- Prefer Vitest or the project-defined test runner for TypeScript units and integration tests.
- Use Playwright for UI and terminal interaction tests once the desktop/web test harness exists.
- New features require tests.
- Bug fixes require regression tests.
- PTY behavior should be tested at the public session/protocol boundary. Avoid asserting on private implementation details.
- TUI and terminal rendering tests should verify observable screen state, process lifecycle, and input/output behavior.
- Avoid fixed sleeps to wait for async operations. Prefer events, promises, stream reads, polling helpers with timeouts, or Playwright assertions that retry.
- Wrap indefinite waits in explicit timeouts to prevent hung test runs.
- **Failing tests are signals, not obstacles.** When a code change causes existing tests to fail, do not modify the test just to make it pass without first understanding why it failed. A failing test may indicate a real bug, unintended behavior shift, or violated contract. Investigate the root cause, explain it to the user, and agree on the right fix before proceeding. Only update a test without consulting the user when the change is unambiguously correct, such as a renamed field that the test still references.
- After making changes, run formatting, linting, type checks, tests, and any relevant build or packaging checks that exist in the repo.

## Conversational Implementation Guidelines

Interpret the user's intent from each question and respond accordingly. Although your primary role is to be a coding partner, you should also function as a thoughtful conversational partner. Users may first want to discuss features, explore ideas, review design decisions, or ask general questions about the project or codebase. In such cases, focus on answering clearly, adding useful context, and helping the user think through the problem.

Contribute beyond direct answers by suggesting improvements, implementation approaches, design considerations, and things to avoid. Only start implementing code when the user explicitly asks you to do so.

## Updates to AGENTS.md

Only add what a coding agent cannot infer from reading the code.

| Include in this section                              | Do NOT include                                     |
| ---------------------------------------------------- | -------------------------------------------------- |
| Commands agents cannot guess                         | Anything an agent can figure out by reading code   |
| Code style rules that differ from defaults           | Standard language conventions agents already know  |
| Testing instructions and preferred test runners      | Detailed API documentation; link to specs instead  |
| Repository etiquette and PR conventions              | Information that changes frequently                |
| Architectural decisions specific to this project     | Long explanations or tutorials                     |
| Developer environment quirks                         | File-by-file descriptions of the codebase          |
| Common gotchas or non-obvious behaviors              | Self-evident practices like "write clean code"     |
