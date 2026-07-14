import { useCallback, useEffect, useRef, useState } from "react";

import type {
  AgentPermissionRequest,
  PermissionResolutionDecision,
  RendererSessionEvent,
} from "@terminal/protocol";

import { applyPermissionEvent, createPermissionQueue } from "./permission-model";

export function useAgentPermissions(reportError: (error: unknown) => void): {
  requests: AgentPermissionRequest[];
  resolve: (permissionId: string, decision: PermissionResolutionDecision) => void;
} {
  const [requests, setRequests] = useState<AgentPermissionRequest[]>([]);
  const bootstrapPending = useRef(true);
  const bufferedEvents = useRef<RendererSessionEvent[]>([]);

  useEffect(
    () =>
      window.terminalApi.onTerminalEvent((event) => {
        if (event.type !== "permission.requested" && event.type !== "permission.resolved") return;
        if (bootstrapPending.current) {
          bufferedEvents.current.push(event);
          return;
        }
        setRequests((current) => applyPermissionEvent(current, event));
      }),
    [],
  );

  useEffect(() => {
    let disposed = false;
    void window.terminalApi
      .listPermissions()
      .then((pending) => {
        if (disposed) return;
        const buffered = bufferedEvents.current;
        bufferedEvents.current = [];
        bootstrapPending.current = false;
        setRequests(
          buffered.reduce(
            (current, event) => applyPermissionEvent(current, event),
            createPermissionQueue(pending),
          ),
        );
      })
      .catch((error: unknown) => {
        if (disposed) return;
        bootstrapPending.current = false;
        setRequests((current) =>
          bufferedEvents.current.reduce(
            (next, event) => applyPermissionEvent(next, event),
            current,
          ),
        );
        bufferedEvents.current = [];
        reportError(error);
      });
    return () => {
      disposed = true;
    };
  }, [reportError]);

  const resolve = useCallback(
    (permissionId: string, decision: PermissionResolutionDecision) => {
      void window.terminalApi
        .resolvePermission({ permissionId, decision })
        .then(() => {
          setRequests((current) =>
            current.filter((request) => request.permissionId !== permissionId),
          );
        })
        .catch(reportError);
    },
    [reportError],
  );

  return { requests, resolve };
}
