import type {
  AgentSessionControlState,
  RendererSessionEvent,
  SessionId,
  TerminalSessionSummary,
} from "@terminal/protocol";

export type SessionListState = {
  sessions: Map<SessionId, TerminalSessionSummary>;
  controls: Map<SessionId, AgentSessionControlState>;
};

export type SessionListItem = {
  session: TerminalSessionSummary;
  control: AgentSessionControlState;
};

export function createSessionListState(
  sessions: TerminalSessionSummary[],
  controls: AgentSessionControlState[],
): SessionListState {
  return {
    sessions: new Map(sessions.map((session) => [session.sessionId, session])),
    controls: new Map(controls.map((control) => [control.sessionId, control])),
  };
}

export function applySessionListEvent(
  state: SessionListState,
  event: RendererSessionEvent,
): SessionListState {
  switch (event.type) {
    case "session.updated": {
      const sessions = new Map(state.sessions);
      sessions.set(event.payload.sessionId, event.payload);
      return { ...state, sessions };
    }
    case "session.removed": {
      const sessions = new Map(state.sessions);
      const controls = new Map(state.controls);
      sessions.delete(event.payload.sessionId);
      controls.delete(event.payload.sessionId);
      return { sessions, controls };
    }
    case "agent.control.changed": {
      const controls = new Map(state.controls);
      if (event.payload.state === "detached") controls.delete(event.payload.sessionId);
      else controls.set(event.payload.sessionId, event.payload);
      return { ...state, controls };
    }
    case "session.output":
    case "session.viewport":
    case "session.bell":
    case "session.error":
    case "agent.activity":
    case "policy.denied":
    case "permission.requested":
    case "permission.resolved":
    case "presentation.command":
      return state;
  }
}

export function sessionListItems(state: SessionListState): SessionListItem[] {
  return [...state.sessions.values()]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map((session) => ({
      session,
      control: state.controls.get(session.sessionId) ?? detachedControlState(session.sessionId),
    }));
}

export function sessionCommandLabel(session: TerminalSessionSummary): string {
  switch (session.command.state) {
    case "running":
      return "Command running";
    case "idle":
      return session.command.lastCommand
        ? `Idle · exit ${session.command.lastCommand.exitCode ?? "unknown"}`
        : "Idle";
    case "unknown":
      return "Command state unknown";
  }
}

function detachedControlState(sessionId: SessionId): AgentSessionControlState {
  return { sessionId, state: "detached", attachedAt: null };
}
