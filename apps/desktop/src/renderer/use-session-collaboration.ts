import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";

import type { RendererSessionEvent, SessionId, TerminalSessionSummary } from "@terminal/protocol";

import type { TerminalController } from "./terminal-controller";
import { addAttachedTerminalTab, closeTerminalTab } from "./terminal-tabs";
import type { TerminalTabsState } from "./terminal-tabs";
import {
  addNotification,
  isPolicyDenialError,
  notificationFromError,
  notificationFromPolicyDenial,
  successNotification,
  type UiNotification,
} from "./notifications";
import {
  applySessionListEvent,
  createSessionListState,
  sessionListItems,
} from "./session-list-model";
import type { SessionSidebarActions } from "./session-sidebar";

export type SessionCollaboration = {
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  items: ReturnType<typeof sessionListItems>;
  notifications: UiNotification[];
  dismissNotification: (id: string) => void;
  reportError: (error: unknown) => void;
  actions: SessionSidebarActions;
};

export function useSessionCollaboration({
  tabsStateRef,
  controllers,
  setTabsState,
}: {
  tabsStateRef: MutableRefObject<TerminalTabsState | null>;
  controllers: MutableRefObject<Map<string, TerminalController>>;
  setTabsState: Dispatch<SetStateAction<TerminalTabsState | null>>;
}): SessionCollaboration {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sessionListState, setSessionListState] = useState(() => createSessionListState([], []));
  const [notifications, setNotifications] = useState<UiNotification[]>([]);
  const bootstrapPending = useRef(true);
  const bufferedSessionListEvents = useRef<RendererSessionEvent[]>([]);

  const reportError = useCallback((error: unknown) => {
    if (isPolicyDenialError(error)) return;
    setNotifications((current) => addNotification(current, notificationFromError(error)));
  }, []);

  const handleEvent = useCallback(
    (event: RendererSessionEvent) => {
      if (isSessionListEvent(event)) {
        if (bootstrapPending.current) {
          bufferedSessionListEvents.current.push(event);
        } else {
          setSessionListState((current) => applySessionListEvent(current, event));
        }
      }
      if (event.type === "policy.denied") {
        setNotifications((current) =>
          addNotification(current, notificationFromPolicyDenial(event.payload)),
        );
      } else if (event.type === "session.removed") {
        setTabsState((current) => {
          if (!current) return current;
          const tab = current.tabs.find(
            (candidate) => candidate.sessionId === event.payload.sessionId,
          );
          return tab ? closeTerminalTab(current, tab.id) : current;
        });
      }
    },
    [setTabsState],
  );

  useEffect(() => window.terminalApi.onTerminalEvent(handleEvent), [handleEvent]);

  useEffect(() => {
    let disposed = false;
    void Promise.all([window.terminalApi.listSessions(), window.terminalApi.listAgentControls()])
      .then(([sessions, controls]) => {
        if (disposed) return;
        const buffered = bufferedSessionListEvents.current;
        bufferedSessionListEvents.current = [];
        bootstrapPending.current = false;
        setSessionListState(
          buffered.reduce(
            (state, event) => applySessionListEvent(state, event),
            createSessionListState(sessions, controls),
          ),
        );
      })
      .catch((error: unknown) => {
        if (disposed) return;
        const buffered = bufferedSessionListEvents.current;
        bufferedSessionListEvents.current = [];
        bootstrapPending.current = false;
        setSessionListState((current) =>
          buffered.reduce((state, event) => applySessionListEvent(state, event), current),
        );
        reportError(error);
      });
    return () => {
      disposed = true;
    };
  }, [reportError]);

  const revealSession = useCallback(
    (session: TerminalSessionSummary) => {
      setTabsState((current) =>
        current ? addAttachedTerminalTab(current, session, { activate: true }) : current,
      );
    },
    [setTabsState],
  );

  const hideSession = useCallback(
    (session: TerminalSessionSummary) => {
      const current = tabsStateRef.current;
      const tab = current?.tabs.find((candidate) => candidate.sessionId === session.sessionId);
      if (!tab) {
        void window.terminalApi.closeView({ sessionId: session.sessionId }).catch(reportError);
        return;
      }
      const controller = controllers.current.get(tab.id);
      void (controller?.dispose() ?? Promise.resolve(true))
        .then((disposed) => {
          if (!disposed) return;
          setTabsState((state) => (state ? closeTerminalTab(state, tab.id) : state));
        })
        .catch(reportError);
    },
    [controllers, reportError, setTabsState, tabsStateRef],
  );

  const revokeAgentControl = useCallback(
    (sessionId: SessionId) => {
      void window.terminalApi
        .revokeAgentControl({ sessionId })
        .then((control) => {
          setSessionListState((current) =>
            applySessionListEvent(current, { type: "agent.control.changed", payload: control }),
          );
          setNotifications((current) =>
            addNotification(
              current,
              successNotification("Agent control revoked", "The terminal session remains active."),
            ),
          );
        })
        .catch(reportError);
    },
    [reportError],
  );

  const allowAgentControl = useCallback(
    (sessionId: SessionId) => {
      void window.terminalApi
        .allowAgentControl({ sessionId })
        .then((control) => {
          setSessionListState((current) =>
            applySessionListEvent(current, { type: "agent.control.changed", payload: control }),
          );
          setNotifications((current) =>
            addNotification(
              current,
              successNotification(
                "Agent control allowed",
                "An agent may now attach to this terminal session.",
              ),
            ),
          );
        })
        .catch(reportError);
    },
    [reportError],
  );

  const terminateSession = useCallback(
    (session: TerminalSessionSummary) => {
      const verb =
        session.lifecycle === "exited" || session.lifecycle === "failed" ? "Remove" : "Terminate";
      if (!window.confirm(`${verb} ${session.title || session.cwd}?`)) return false;
      const current = tabsStateRef.current;
      const tab = current?.tabs.find((candidate) => candidate.sessionId === session.sessionId);
      const controller = tab ? controllers.current.get(tab.id) : undefined;
      const close = controller
        ? controller.dispose({ sessionLifecycle: "terminate" })
        : window.terminalApi
            .close({ sessionId: session.sessionId })
            .then((result) => result.status === "closed");
      void close
        .then((closed) => {
          if (!closed || !tab) return;
          setTabsState((state) => (state ? closeTerminalTab(state, tab.id) : state));
        })
        .catch(reportError);
      return true;
    },
    [controllers, reportError, setTabsState, tabsStateRef],
  );

  const actions = useMemo<SessionSidebarActions>(
    () => ({
      reveal: revealSession,
      hide: hideSession,
      revoke: revokeAgentControl,
      allow: allowAgentControl,
      terminate: terminateSession,
      startRecording: (sessionId) => {
        void window.terminalApi.startRecording({ sessionId }).catch(reportError);
      },
      stopRecording: (sessionId) => {
        void window.terminalApi.stopRecording({ sessionId }).catch(reportError);
      },
      exportRecording: (sessionId) => {
        void window.terminalApi
          .exportRecordingFile({ sessionId })
          .then((result) => {
            if (result.status === "saved") {
              setNotifications((current) =>
                addNotification(
                  current,
                  successNotification("Recording exported", result.fileName),
                ),
              );
            }
          })
          .catch(reportError);
      },
    }),
    [
      allowAgentControl,
      hideSession,
      reportError,
      revealSession,
      revokeAgentControl,
      terminateSession,
    ],
  );

  return {
    sidebarOpen,
    toggleSidebar: () => setSidebarOpen((open) => !open),
    items: sessionListItems(sessionListState),
    notifications,
    dismissNotification: (id) =>
      setNotifications((current) => current.filter((notification) => notification.id !== id)),
    reportError,
    actions,
  };
}

function isSessionListEvent(
  event: RendererSessionEvent,
): event is Extract<
  RendererSessionEvent,
  { type: "session.updated" | "session.removed" | "agent.control.changed" }
> {
  return (
    event.type === "session.updated" ||
    event.type === "session.removed" ||
    event.type === "agent.control.changed"
  );
}
