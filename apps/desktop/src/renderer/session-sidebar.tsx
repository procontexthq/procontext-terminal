import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";

import type { SessionId, TerminalSessionSummary } from "@terminal/protocol";

import { sessionCommandLabel, type SessionListItem } from "./session-list-model";

export type SessionSidebarActions = {
  reveal(session: TerminalSessionSummary): void;
  hide(session: TerminalSessionSummary): void;
  revoke(sessionId: SessionId): void;
  allow(sessionId: SessionId): void;
  terminate(session: TerminalSessionSummary): boolean;
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
  const [openActionsSessionId, setOpenActionsSessionId] = useState<SessionId | null>(null);
  const moreButtonRefs = useRef(new Map<SessionId, HTMLButtonElement>());
  const removalFocus = useRef<{
    removedSessionId: SessionId;
    fallbackSessionId: SessionId | null;
  } | null>(null);

  useEffect(() => {
    if (
      openActionsSessionId &&
      (!open || !items.some(({ session }) => session.sessionId === openActionsSessionId))
    ) {
      setOpenActionsSessionId(null);
    }
  }, [items, open, openActionsSessionId]);

  useEffect(() => {
    const pending = removalFocus.current;
    if (!pending || items.some(({ session }) => session.sessionId === pending.removedSessionId)) {
      return;
    }
    removalFocus.current = null;
    const fallback = pending.fallbackSessionId
      ? moreButtonRefs.current.get(pending.fallbackSessionId)
      : null;
    (
      fallback ?? document.querySelector<HTMLButtonElement>('[aria-controls="session-sidebar"]')
    )?.focus();
  }, [items]);

  useEffect(() => {
    if (!open || !openActionsSessionId) return undefined;
    const moreButton = moreButtonRefs.current.get(openActionsSessionId);
    const card = moreButton?.closest(".session-card");
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpenActionsSessionId(null);
      moreButton?.focus();
    };
    const handlePointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node) || !card?.contains(event.target)) {
        setOpenActionsSessionId(null);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [open, openActionsSessionId]);

  const closeSecondaryActions = (sessionId: SessionId): void => {
    moreButtonRefs.current.get(sessionId)?.focus();
    setOpenActionsSessionId(null);
  };

  if (!open) return null;

  return (
    <aside
      id="session-sidebar"
      className="session-sidebar"
      aria-label="Terminal sessions"
      data-testid="session-sidebar"
    >
      <div className="session-sidebar-header">
        <div>
          <strong>Sessions</strong>
          <span
            aria-label={`${items.length} terminal ${items.length === 1 ? "session" : "sessions"}`}
          >
            {items.length}
          </span>
        </div>
        <p>
          Human and agent terminals {"\u00b7"} Redaction{" "}
          {redactionPatternCount > 0
            ? `${redactionPatternCount} ${redactionPatternCount === 1 ? "pattern" : "patterns"}`
            : "off"}
        </p>
      </div>
      <div className="session-list">
        {items.map(({ session, control }, index) => {
          const active = activeSessionId === session.sessionId;
          const visible =
            session.presentation.state === "background" ||
            session.presentation.state === "foreground" ||
            active;
          const finished = session.lifecycle === "exited" || session.lifecycle === "failed";
          const name = sessionName(session);
          const titleId = `session-title-${session.sessionId}`;
          const secondaryActionsId = `session-secondary-actions-${session.sessionId}`;
          const secondaryActionsOpen = openActionsSessionId === session.sessionId;
          const presentationAction = active ? "Hide" : visible ? "Focus" : "Reveal";
          return (
            <article
              className={`session-card${active ? " is-active" : ""}`}
              key={session.sessionId}
              data-session-id={session.sessionId}
              data-testid={`session-card-${session.sessionId}`}
              aria-labelledby={titleId}
            >
              <header>
                <div className="session-card-heading">
                  <strong id={titleId}>{name}</strong>
                  <span className={`session-origin is-${session.createdBy}`}>
                    {session.createdBy}
                  </span>
                </div>
                <div className="session-card-states">
                  <span className={`session-lifecycle is-${session.lifecycle}`}>
                    {session.lifecycle}
                  </span>
                  {control.state !== "detached" ? (
                    <span className={`session-control is-${control.state}`}>
                      {control.state === "attached" ? "Agent attached" : "Agent blocked"}
                    </span>
                  ) : null}
                </div>
              </header>
              <dl className="session-metadata">
                <div>
                  <dt>Command</dt>
                  <dd>{sessionCommandLabel(session)}</dd>
                </div>
                <div>
                  <dt>View</dt>
                  <dd>{session.presentation.state}</dd>
                </div>
                <div className="session-cwd">
                  <dt>cwd</dt>
                  <dd title={session.cwd}>{session.cwd}</dd>
                </div>
                <div>
                  <dt>Shell</dt>
                  <dd>{session.shellIntegration.status}</dd>
                </div>
                <div>
                  <dt>Recording</dt>
                  <dd>{session.recording.state}</dd>
                </div>
              </dl>
              <div className="session-actions">
                <button
                  type="button"
                  onClick={() => {
                    setOpenActionsSessionId(null);
                    if (active) actions.hide(session);
                    else actions.reveal(session);
                  }}
                >
                  {presentationAction}
                </button>
                {session.recording.state === "active" ? (
                  <button
                    type="button"
                    onClick={() => {
                      setOpenActionsSessionId(null);
                      actions.stopRecording(session.sessionId);
                    }}
                  >
                    Stop recording
                  </button>
                ) : !finished ? (
                  <button
                    type="button"
                    onClick={() => {
                      setOpenActionsSessionId(null);
                      actions.startRecording(session.sessionId);
                    }}
                  >
                    Record
                  </button>
                ) : null}
                <button
                  ref={(element) => {
                    if (element) moreButtonRefs.current.set(session.sessionId, element);
                    else moreButtonRefs.current.delete(session.sessionId);
                  }}
                  type="button"
                  className="session-more-button"
                  aria-label={`More actions for ${name}`}
                  aria-expanded={secondaryActionsOpen}
                  aria-controls={secondaryActionsId}
                  title={`More actions for ${name}`}
                  onClick={() =>
                    setOpenActionsSessionId((current) =>
                      current === session.sessionId ? null : session.sessionId,
                    )
                  }
                >
                  <span aria-hidden="true">...</span>
                </button>
              </div>
              {secondaryActionsOpen ? (
                <div
                  id={secondaryActionsId}
                  className="session-secondary-actions"
                  role="group"
                  aria-label={`More actions for ${name}`}
                >
                  {control.state === "attached" ? (
                    <button
                      type="button"
                      onClick={() => {
                        closeSecondaryActions(session.sessionId);
                        actions.revoke(session.sessionId);
                      }}
                    >
                      Revoke agent
                    </button>
                  ) : null}
                  {control.state === "revoked" ? (
                    <button
                      type="button"
                      onClick={() => {
                        closeSecondaryActions(session.sessionId);
                        actions.allow(session.sessionId);
                      }}
                    >
                      Allow agent control
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => {
                      closeSecondaryActions(session.sessionId);
                      actions.exportRecording(session.sessionId);
                    }}
                  >
                    Export recording
                  </button>
                  <button
                    type="button"
                    className="is-danger"
                    onClick={() => {
                      closeSecondaryActions(session.sessionId);
                      if (actions.terminate(session)) {
                        removalFocus.current = {
                          removedSessionId: session.sessionId,
                          fallbackSessionId:
                            items[index + 1]?.session.sessionId ??
                            items[index - 1]?.session.sessionId ??
                            null,
                        };
                      }
                    }}
                  >
                    {finished ? "Remove" : "Terminate"}
                  </button>
                </div>
              ) : null}
            </article>
          );
        })}
        {items.length === 0 ? <p className="session-list-empty">No terminal sessions</p> : null}
      </div>
    </aside>
  );
}

function sessionName(session: TerminalSessionSummary): string {
  return session.title || basename(session.cwd) || basename(session.shell);
}

function basename(value: string): string {
  const parts = value.split(/[\\/]/u).filter(Boolean);
  return parts.at(-1) ?? value;
}
