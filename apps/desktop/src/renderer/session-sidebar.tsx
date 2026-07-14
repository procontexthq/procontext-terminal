import type { ReactElement } from "react";

import type { SessionId, TerminalSessionSummary } from "@terminal/protocol";

import { sessionCommandLabel, type SessionListItem } from "./session-list-model";

export type SessionSidebarActions = {
  reveal(session: TerminalSessionSummary): void;
  hide(session: TerminalSessionSummary): void;
  revoke(sessionId: SessionId): void;
  allow(sessionId: SessionId): void;
  terminate(session: TerminalSessionSummary): void;
  startRecording(sessionId: SessionId): void;
  stopRecording(sessionId: SessionId): void;
  exportRecording(sessionId: SessionId): void;
};

export function SessionSidebar({
  open,
  items,
  activeSessionId,
  redactionPatternCount,
  actions,
}: {
  open: boolean;
  items: SessionListItem[];
  activeSessionId: SessionId | null;
  redactionPatternCount: number;
  actions: SessionSidebarActions;
}): ReactElement | null {
  if (!open) return null;

  return (
    <aside className="session-sidebar" aria-label="Terminal sessions" data-testid="session-sidebar">
      <div className="session-sidebar-header">
        <div>
          <strong>Sessions</strong>
          <span>{items.length}</span>
        </div>
        <p>
          Human and agent terminals · Redaction{" "}
          {redactionPatternCount > 0
            ? `${redactionPatternCount} ${redactionPatternCount === 1 ? "pattern" : "patterns"}`
            : "off"}
        </p>
      </div>
      <div className="session-list">
        {items.map(({ session, control }) => {
          const visible =
            session.presentation.state === "background" ||
            session.presentation.state === "foreground" ||
            activeSessionId === session.sessionId;
          const finished = session.lifecycle === "exited" || session.lifecycle === "failed";
          return (
            <article
              className={`session-card${activeSessionId === session.sessionId ? " is-active" : ""}`}
              key={session.sessionId}
              data-session-id={session.sessionId}
              data-testid={`session-card-${session.sessionId}`}
            >
              <header>
                <div>
                  <strong>
                    {session.title || basename(session.cwd) || basename(session.shell)}
                  </strong>
                  <span className={`session-origin is-${session.createdBy}`}>
                    {session.createdBy}
                  </span>
                </div>
                <span className={`session-control is-${control.state}`}>
                  {control.state === "attached"
                    ? "Agent attached"
                    : control.state === "revoked"
                      ? "Agent blocked"
                      : "No agent"}
                </span>
              </header>
              <dl className="session-metadata">
                <div>
                  <dt>Lifecycle</dt>
                  <dd>{session.lifecycle}</dd>
                </div>
                <div>
                  <dt>View</dt>
                  <dd>{session.presentation.state}</dd>
                </div>
                <div>
                  <dt>Command</dt>
                  <dd>{sessionCommandLabel(session)}</dd>
                </div>
                <div>
                  <dt>Shell</dt>
                  <dd>{session.shellIntegration.status}</dd>
                </div>
                <div className="session-cwd">
                  <dt>cwd</dt>
                  <dd title={session.cwd}>{session.cwd}</dd>
                </div>
                <div>
                  <dt>Recording</dt>
                  <dd>{session.recording.state}</dd>
                </div>
              </dl>
              <div className="session-actions">
                <button type="button" onClick={() => actions.reveal(session)}>
                  {visible ? "Focus" : "Reveal"}
                </button>
                {visible ? (
                  <button type="button" onClick={() => actions.hide(session)}>
                    Hide
                  </button>
                ) : null}
                {control.state === "attached" ? (
                  <button type="button" onClick={() => actions.revoke(session.sessionId)}>
                    Revoke agent
                  </button>
                ) : null}
                {control.state === "revoked" ? (
                  <button type="button" onClick={() => actions.allow(session.sessionId)}>
                    Allow agent control
                  </button>
                ) : null}
                {session.recording.state === "active" ? (
                  <button type="button" onClick={() => actions.stopRecording(session.sessionId)}>
                    Stop recording
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={finished}
                    onClick={() => actions.startRecording(session.sessionId)}
                  >
                    Record
                  </button>
                )}
                <button type="button" onClick={() => actions.exportRecording(session.sessionId)}>
                  Export
                </button>
                <button
                  type="button"
                  className="is-danger"
                  onClick={() => actions.terminate(session)}
                >
                  {finished ? "Remove" : "Terminate"}
                </button>
              </div>
            </article>
          );
        })}
        {items.length === 0 ? <p className="session-list-empty">No terminal sessions</p> : null}
      </div>
    </aside>
  );
}

function basename(value: string): string {
  const parts = value.split(/[\\/]/u).filter(Boolean);
  return parts.at(-1) ?? value;
}
