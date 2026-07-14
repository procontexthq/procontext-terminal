import type {
  AgentPermissionRequest,
  PermissionResolutionOutcome,
  PolicyPrompt,
  ResolvePermissionRequest,
} from "@terminal/protocol";

export type PermissionBroker = {
  request(prompt: PolicyPrompt, signal?: AbortSignal): Promise<PermissionResolutionOutcome>;
  list(): AgentPermissionRequest[];
  resolve(request: ResolvePermissionRequest): boolean;
  cancelPending(): void;
  dispose(): void;
};

type PendingPermission = {
  request: AgentPermissionRequest;
  resolve: (outcome: PermissionResolutionOutcome) => void;
  timeout: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abortHandler?: () => void;
};

const maximumPendingPermissions = 20;

export function createPermissionBroker({
  onRequested,
  onResolved,
  timeoutMs = 30_000,
  now = () => new Date(),
}: {
  onRequested?: (request: AgentPermissionRequest) => void;
  onResolved?: (event: { permissionId: string; outcome: PermissionResolutionOutcome }) => void;
  timeoutMs?: number;
  now?: () => Date;
} = {}): PermissionBroker {
  const pending = new Map<string, PendingPermission>();

  return {
    request(prompt, signal) {
      const existing = pending.get(prompt.decisionId);
      if (existing) {
        return Promise.resolve("cancelled");
      }
      if (pending.size >= maximumPendingPermissions) {
        return Promise.resolve("cancelled");
      }

      const requestedAt = now();
      const request: AgentPermissionRequest = {
        permissionId: prompt.decisionId,
        category: prompt.category,
        operation: prompt.operation,
        ...(prompt.sessionId ? { sessionId: prompt.sessionId } : {}),
        requestedAt: requestedAt.toISOString(),
        expiresAt: new Date(requestedAt.getTime() + timeoutMs).toISOString(),
      };

      return new Promise((resolve) => {
        const timeout = setTimeout(() => settle(prompt.decisionId, "timeout"), timeoutMs);
        const abortHandler = signal ? () => settle(prompt.decisionId, "cancelled") : undefined;
        pending.set(prompt.decisionId, {
          request,
          resolve,
          timeout,
          ...(signal ? { signal } : {}),
          ...(abortHandler ? { abortHandler } : {}),
        });
        if (signal?.aborted) {
          settle(prompt.decisionId, "cancelled");
          return;
        }
        if (abortHandler) signal?.addEventListener("abort", abortHandler, { once: true });
        onRequested?.(request);
      });
    },
    list() {
      return [...pending.values()].map(({ request }) => request);
    },
    resolve(request) {
      return settle(request.permissionId, request.decision);
    },
    cancelPending,
    dispose: cancelPending,
  };

  function cancelPending(): void {
    for (const permissionId of [...pending.keys()]) {
      settle(permissionId, "cancelled");
    }
  }

  function settle(permissionId: string, outcome: PermissionResolutionOutcome): boolean {
    const item = pending.get(permissionId);
    if (!item) return false;
    pending.delete(permissionId);
    clearTimeout(item.timeout);
    if (item.signal && item.abortHandler) {
      item.signal.removeEventListener("abort", item.abortHandler);
    }
    item.resolve(outcome);
    onResolved?.({ permissionId, outcome });
    return true;
  }
}
