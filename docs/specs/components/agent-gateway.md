# Agent Gateway

## Status

Accepted component architecture.

## Purpose

The agent gateway exposes terminal control to autonomous agents through a local, authenticated, validated, and audited API. It maps agent requests to session manager operations.

This component is part of the [Terminal Architecture Spec](../terminal-architecture.md).

## Responsibilities

- Accept local-only agent connections.
- Authenticate callers.
- Validate every request at runtime.
- Map agent requests to session manager commands.
- Enforce session ownership and policy.
- Emit audit events for agent actions.
- Stream observations and lifecycle events back to the agent.

## Transport

Primary transport:

- Local WebSocket over loopback with a short-lived auth token.

Not allowed by default:

- Unauthenticated network binding.
- Remote network control without explicit configuration and policy support.

## API Categories

- Session: create, attach, list, get, kill.
- Input: send text, send key, send paste, send mouse, interrupt.
- Layout: resize, focus, open window, split pane.
- Observation: recent output, viewport, screen snapshot, cursor, title, lifecycle.
- Synchronization: wait for text, wait for prompt, wait for quiet, wait for screen change.
- Recording: start, stop, export, replay metadata.

## Boundaries

The agent gateway must not:

- Spawn PTYs directly.
- Bypass the terminal session manager.
- Trust external messages without validation.
- Bind unauthenticated network control by default.
- Treat agent observations as application logs.

## Testing Expectations

- Unauthenticated requests are rejected.
- Invalid payloads fail closed with typed errors.
- Allowed requests map to the expected session manager operation.
- Denied requests produce policy denial events without side effects.
- Event streams preserve session identity and lifecycle ordering.
