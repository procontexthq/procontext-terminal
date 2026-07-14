import type { AgentPermissionRequest, RendererSessionEvent } from "@terminal/protocol";

const maximumPendingPermissions = 20;

export function createPermissionQueue(
  requests: AgentPermissionRequest[],
): AgentPermissionRequest[] {
  const unique = new Map<string, AgentPermissionRequest>();
  for (const request of requests) unique.set(request.permissionId, request);
  return [...unique.values()].slice(-maximumPendingPermissions);
}

export function applyPermissionEvent(
  requests: AgentPermissionRequest[],
  event: RendererSessionEvent,
): AgentPermissionRequest[] {
  switch (event.type) {
    case "permission.requested":
      return createPermissionQueue([
        ...requests.filter((request) => request.permissionId !== event.payload.permissionId),
        event.payload,
      ]);
    case "permission.resolved":
      return requests.filter((request) => request.permissionId !== event.payload.permissionId);
    default:
      return requests;
  }
}
