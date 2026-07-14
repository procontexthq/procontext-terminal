import type { SessionId } from "@terminal/protocol";

export type ActiveSessionRequest = {
  sessionId?: SessionId;
  signal: AbortSignal;
  controlRevoked: boolean;
};

export type SessionRequestTracker = {
  begin(sessionId: SessionId | undefined): ActiveSessionRequest;
  end(request: ActiveSessionRequest): void;
  abortSession(sessionId: SessionId): void;
  markControlRevoked(sessionId: SessionId): void;
};

type TrackedRequest = ActiveSessionRequest & {
  controller: AbortController;
  abortFromConnection: () => void;
};

export function createSessionRequestTracker(connectionSignal: AbortSignal): SessionRequestTracker {
  const requests = new Set<TrackedRequest>();

  return {
    begin(sessionId) {
      const controller = new AbortController();
      const abortFromConnection = () => controller.abort();
      if (connectionSignal.aborted) controller.abort();
      else connectionSignal.addEventListener("abort", abortFromConnection, { once: true });
      const request: TrackedRequest = {
        ...(sessionId ? { sessionId } : {}),
        signal: controller.signal,
        controller,
        abortFromConnection,
        controlRevoked: false,
      };
      requests.add(request);
      return request;
    },
    end(request) {
      const tracked = request as TrackedRequest;
      requests.delete(tracked);
      connectionSignal.removeEventListener("abort", tracked.abortFromConnection);
    },
    abortSession(sessionId) {
      for (const request of requests) {
        if (request.sessionId === sessionId) request.controller.abort();
      }
    },
    markControlRevoked(sessionId) {
      for (const request of requests) {
        if (request.sessionId !== sessionId) continue;
        request.controlRevoked = true;
        request.controller.abort();
      }
    },
  };
}
