import type { ReactElement } from "react";

import type { AgentPermissionRequest, PermissionResolutionDecision } from "@terminal/protocol";

export function PermissionCenter({
  requests,
  onResolve,
}: {
  requests: AgentPermissionRequest[];
  onResolve: (permissionId: string, decision: PermissionResolutionDecision) => void;
}): ReactElement | null {
  if (requests.length === 0) return null;

  return (
    <section
      className="permission-center"
      aria-label="Agent permission requests"
      aria-live="assertive"
      data-testid="permission-center"
    >
      {requests.map((request) => (
        <article
          className="permission-request"
          key={request.permissionId}
          data-testid={`permission-${request.sessionId ?? request.permissionId}`}
        >
          <div>
            <strong>Agent requests {request.category}</strong>
            <p>
              <code>{request.operation}</code>
              {request.sessionId ? ` · Session ${request.sessionId}` : ""}
            </p>
            <span>Allowing applies once to this request.</span>
          </div>
          <div className="permission-actions">
            <button
              type="button"
              className="is-primary"
              onClick={() => onResolve(request.permissionId, "allow")}
            >
              Allow once
            </button>
            <button type="button" onClick={() => onResolve(request.permissionId, "deny")}>
              Deny
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}
