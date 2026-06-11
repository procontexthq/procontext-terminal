---
description: "Make sure to follow the rules mentioned when writing or reviewing any code in this repository."
---

# Coding Guidelines

Follow these rules when writing or reviewing any code in this repository.

---

## Agent Operating Discipline

### Think before coding

Do not assume. Do not hide confusion. Surface tradeoffs.

Before implementing:

- State assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them. Do not pick silently.
- If a simpler approach exists, say so.
- If something is unclear, stop, name what is unclear, and ask.

### Simplicity first

Minimum code that solves the problem. Nothing speculative.

- No features beyond what was asked.
- No abstractions for single-use code.
- No configurability that is not needed now or clearly justified by the design.
- No error handling for impossible scenarios.
- Error handling must still cover realistic failures, external boundaries, user input, IPC, filesystem, PTY, and process lifecycle failures.
- If the code is hard to understand because it is trying to handle too much, simplify it.

### Abstractions and configurability

Add structure when it helps. Do not add structure because it might help someday.

- Create an abstraction when it removes real duplication, clarifies ownership, isolates a boundary, or makes future changes easier in a concrete way.
- Do not create an abstraction only to make the code look flexible.
- Do not add configuration knobs without a current use case or a documented design reason.
- When the need for an abstraction becomes clear later, change direction then. Prefer a structured correction over guessing too early.
- Keep the path adaptable, not fixed.

### Surgical changes

Touch only what you must. Clean up only your own changes.

- Do not improve adjacent code, comments, or formatting unless the task requires it.
- Do not refactor unrelated code.
- Match existing style, even if you would write it differently.
- If you notice unrelated dead code, mention it. Do not delete it unless asked.
- Remove imports, variables, functions, or tests that your own change made unused.

Every changed line should trace directly to the user request, the spec, or the implementation needed to satisfy them.

### Goal-driven execution

Define success criteria. Loop until verified.

For non-trivial work:

- State what success means before implementing.
- Prefer tests first for features and bug fixes.
- For bug fixes, write a regression test when practical.
- For refactors, verify behavior before and after.
- Run the relevant project checks after making changes.

Apply this with judgment. Obvious typo fixes, one-line corrections, and mechanical updates do not need a full plan, but they still must stay scoped and verifiable.

---

## API Design

### 1. Make correct usage the easiest path

Structure every API so the default usage is correct and safe. Require deliberate extra effort for dangerous operations. Never let the easy path be the unsafe path.

For this project, creating a terminal should default to a normal user shell in a safe working directory. Destructive or sensitive operations, such as exposing a session to an external agent, enabling remote control, recording transcripts, or spawning privileged shells, must be explicit.

### 2. Treat every observable behavior as a contract

> "With a sufficient number of users of an API, it does not matter what you promise in the contract: all observable behaviors of your system will be depended on by somebody." - Hyrum Wright

Error messages, terminal event ordering, process exit semantics, resize behavior, transcript formats, keyboard mappings, and screen snapshot shape all become de facto contracts over time. Follow these rules:

- Document all observable behaviors explicitly, including ones you consider incidental.
- Add tests for ordering-sensitive behavior at the public API boundary.
- Treat any bug fix that changes observable behavior as a potential breaking change.

### 3. Keep the public surface area minimal

Every interface you expose is a commitment. IPC channel names, agent protocol messages, config schema fields, CLI commands, public package exports, and plugin hooks are all public surface area once consumers rely on them. Default to the most restrictive access modifier or export boundary. Only expose what has a documented, intentional use case. Mark experimental interfaces clearly to reserve the right to change them before fully committing.

### 4. Keep abstractions consistent - no leaks by omission

If some terminal operations require a `sessionId` while others rely on hidden global state, the API is leaking implementation details. Either all logically related operations carry explicit session identity or none do. Do not force consumers to understand internal architecture to use the API correctly.

### 5. Layer complexity progressively

Make the 80% case simple. Make advanced cases accessible but not required reading. Layer the API:

- `createTerminal()` - normal default shell
- `createTerminal({ cwd, shell, env })` - explicit session options
- `createAgentSession({ policy, recorder, screenReader })` - full control

### 6. Design intentional extension and override points

All non-trivial abstractions leak eventually. When a real operator need cannot be met by the default behavior, the answer must be a documented configuration knob or extension point, not a fork. Every extension point must be easy to use when needed, well-integrated, and documented with defaults and caveats.

For this terminal specifically, likely extension points include shell selection, PTY backend selection, environment construction, keyboard mapping, transcript storage, session policy, agent permissioning, screen snapshot generation, prompt detection, and telemetry/logging sinks.

---

## Error Handling

### 7. Never swallow errors in core modules

Low-level modules such as PTY hosts, session managers, IPC handlers, protocol parsers, and transcript stores must not catch errors silently. Catching an error silently steals the decision from the caller: they cannot retry, fall back, alert, or audit what they cannot see.

Always propagate errors with enough context for the caller to act, or convert infrastructure errors into domain errors at the module boundary.

Top-level handlers, UI event handlers, and background tasks may catch errors to prevent process termination, but they must still log them and surface a structured failure to the caller or user where appropriate.

### 8. Use typed, domain-specific error types

Do not force consumers to parse error strings. Use a typed error hierarchy or discriminated union:

```ts
type TerminalError =
  | { type: "pty_spawn_failed"; message: string; shell: string; cause?: unknown }
  | { type: "session_not_found"; message: string; sessionId: string }
  | { type: "permission_denied"; message: string; operation: string };
```

Every error type must carry a classification, human-readable message, and structured data the consumer needs to act on.

### 9. Wrap infrastructure errors at the module boundary

Do not let raw infrastructure exceptions from node-pty, filesystem APIs, Electron IPC, or platform-specific process APIs cross module boundaries. Callers should not need to understand a dependency's internal error classes to handle terminal-domain failures.

Catch infrastructure errors at the module boundary and wrap them in domain error types with the original cause attached.

### 10. Catch specific failures, not everything by default

Catch the narrowest failure mode that covers the expected problem. Reserve catch-all handlers for top-level boundaries and background tasks where any failure must be contained to keep the app alive.

```ts
try {
  await transcriptStore.append(event);
} catch (error: unknown) {
  throw mapTranscriptWriteError(error);
}
```

Do not write a broad `catch` block that hides the error, converts everything to a generic message, or continues as if nothing happened.

### 11. Preserve error causes and never suppress silently

When converting errors, preserve the original cause. When suppressing an error because recovery is not possible or the operation is best-effort, log it through the project logger with structured context.

```ts
// Correct - original cause is preserved.
throw new TerminalDomainError("transcript_write_failed", {
  sessionId,
  cause: error,
});

// Wrong - the cause and useful debugging context are lost.
throw new Error("Failed to write transcript");
```

Silence is never acceptable. Do not write empty `catch` blocks. A comment is not a log entry.

---

## Versioning and Breaking Changes

### 12. Watch for non-obvious breaking changes

Not all breaking changes involve removing a method. Check for these before every release:

- Dropping Node.js, Electron, browser engine, OS, or CPU architecture compatibility
- Changing IPC channel names or payload shapes
- Changing agent protocol message names, required fields, or event ordering
- Changing keyboard shortcut behavior
- Changing terminal resize, scrollback, or transcript semantics
- Changing default shell selection or environment construction
- Changing screen snapshot format
- Changing persisted data formats for settings, transcripts, recordings, or session state
- Changing error types
- Changing default parameter values
- Narrowing accepted input types

### 13. Follow a deprecation cycle before removing anything

Use this lifecycle without exception:

1. Introduce the replacement in a minor release.
2. Deprecate the old API in the same or following minor release with a warning.
3. Escalate to an error-level deprecation in a subsequent minor release.
4. Remove in the next major version.

Every deprecation warning must state when it was deprecated, why, and exactly what to use instead. Allow enough time for downstream users to migrate. Never remove an API in the same commit as its replacement.

### 14. Maintain machine-readable changelogs

Follow [Keep a Changelog](https://keepachangelog.com) format:

- ISO 8601 dates
- `Added / Changed / Deprecated / Removed / Fixed / Security` categories
- Breaking changes prefixed with `BREAKING` in a visible callout

Automate changelog inputs through Conventional Commits and release tooling when the repository has CI. The changelog is the artifact consumers rely on before upgrading; do not skip it.

---

## Code Conventions

### 15. Keep imports at the top of the file

Place imports at module level. Do not import inside functions, methods, or conditional blocks unless there is a documented reason such as optional platform-specific code, lazy loading for startup performance, or breaking a genuine circular import that could not be resolved by restructuring.

Use `import type` for type-only imports. If a dynamic import is necessary, add a short comment explaining why.

### 16. Prefer explicit protocol types over loose objects

All IPC and agent protocol messages should be represented by named TypeScript types. Avoid anonymous object bags for data crossing package or process boundaries.

```ts
type TerminalInputEvent = {
  type: "terminal.input";
  sessionId: SessionId;
  data: string;
};
```

### 17. Keep main, renderer, and shared code boundaries clear

- Main-process code owns native capabilities: PTY, filesystem, process lifecycle, app windows, and OS integration.
- Renderer code owns UI rendering and user interaction.
- Shared packages own serializable types, validation, and pure helpers.
- Agent APIs should call the same session manager contracts used by the UI instead of bypassing them.

Do not import main-process modules into renderer code or renderer modules into main-process code. Shared code must not depend on Electron globals.

### 18. Validate untrusted boundary data

Validate data crossing IPC, agent APIs, config files, persisted sessions, and remote-control boundaries. TypeScript types do not validate runtime data.

Prefer a small schema layer for protocol messages once the API stabilizes. Invalid input should fail closed with structured errors.

---

## Testing Strategy

### 19. Always write tests first

Write tests before implementing new features or fixing bugs. This ensures expected behavior is explicit and helps catch regressions early.

### 20. Testing practices

- Integration tests must test public APIs and observable behavior, not internal implementation details.
- Unit tests should focus on individual components with complex logic, such as protocol validation, key encoding, prompt detection, snapshot parsing, and session state transitions.
- PTY tests should exercise real process behavior where practical, but keep them deterministic and isolated.
- UI tests should verify visible terminal state, focus behavior, keyboard input, copy/paste, resize behavior, and session lifecycle.
- TUI tests should prefer observable screen snapshots and input behavior over raw byte-stream assertions.

### 21. Keep tests for deprecated APIs until removal

Deprecated code is still public API. Maintain tests for it through the entire deprecation cycle. Suppress deprecation warnings explicitly in those test files so future contributors know the suppression is intentional.

### 22. Every bug fix requires a regression test

Do not merge a bug fix without a test that fails before the fix and passes after. This prevents the same bug from reappearing silently in a future refactor.

---

## Supply Chain Security

### 23. Publish provenance attestations

Add SLSA provenance attestation to the release pipeline once distributable artifacts are produced. For desktop apps, attest the packaged artifacts for each OS.

```yaml
- uses: actions/attest-build-provenance@v1
  with:
    subject-path: dist/
```

Enterprise consumers increasingly require provenance. Its absence is an adoption barrier.

### 24. Verify every dependency against the actual registry

AI-suggested packages may not exist in any public registry, and attackers can register hallucinated package names with malicious code. Before adding any dependency, verify the package name exists in the actual registry and is the package you intend to use.

For npm dependencies, verify the package on the npm registry, inspect maintenance status, check native build requirements, and review whether the dependency is appropriate for Electron main, Electron renderer, or shared code.

---

## Maintainability

### 25. Keep functions small and focused

A function should do one thing. If you find yourself reaching for a comment like `Step 2` or `Phase 2`, that is a signal to extract a named function. Functions that are hard to name are usually doing too much.

A useful heuristic: if a function cannot be understood in one reading without scrolling, it is too long.

### 26. Keep files small and focused

A file should own one concern. If the module header requires more than one sentence to summarize all responsibilities, that is a signal to split the file.

A useful heuristic: if you cannot understand what a file does without scrolling through it, it is doing too much. Aim for files where the purpose is obvious from the filename alone.

Prefer flat files for single-concern modules. A subdirectory only earns its place when two or more closely related files belong together and would be confusing in isolation.

Prefer files under `300` lines when possible; treat `500` lines as an exception ceiling that should require a strong cohesion argument.

### 27. Minimize runtime dependencies

Zero dependencies is ideal. When that is not practical, justify every runtime dependency. Each one has an ongoing cost:

- Transitive CVEs become your CVEs to track and patch
- Every dependency is a potential supply-chain attack vector
- More dependencies mean slower installs and larger app bundles
- Native dependencies complicate cross-platform packaging and CI

When you inline a small helper instead of adding a dependency, note the source, version, and license in a comment. Do not add utility packages without weighing the ongoing maintenance cost.

### 28. Keep terminal bytes, app logs, and agent observations separate

Terminal output belongs to the PTY stream. Application logs belong to the logger. Agent observations are structured data derived from sessions. Do not mix these channels.

This separation matters because writing app logs into a PTY corrupts the user's terminal session, while treating terminal output as app logs can leak secrets or make replay/debug data impossible to reason about.

### 29. Use structured, redacted app logs

App diagnostics must go through the project logger and use stable component and event names. Include request IDs, session IDs, origins, and typed error fields when they help trace a failure.

Do not log raw payloads across sensitive boundaries. In particular, never log PTY output, terminal input, clipboard contents, full environments, cookies, credentials, tokens, passwords, or transcript data by default.

When catching an error at a top-level boundary, log a structured event before returning a typed failure or shutting down. A useful log record should let another engineer identify where the failure happened, which operation failed, and which structured error type was produced without needing to reproduce it immediately.
