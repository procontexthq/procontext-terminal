import type { AgentGateway, AgentGatewayOptions } from "@terminal/agent-gateway";
import type {
  AgentPermissionRequest,
  AgentSessionControlState,
  PolicyDenialNotice,
  RecordingControlRequest,
  RecordingExportFileResult,
  RendererSessionEvent,
  ResolvePermissionRequest,
  SessionId,
} from "@terminal/protocol";
import type { TerminalSessionManager } from "@terminal/session-core";

import { exportRecordingToFile, type RecordingExportDependencies } from "./recording-export";
import { createPermissionBroker } from "./permission-broker";

export type DesktopCollaborationServices = {
  renderer: {
    listAgentControls(): AgentSessionControlState[];
    revokeAgentControl(sessionId: SessionId): AgentSessionControlState;
    allowAgentControl(sessionId: SessionId): AgentSessionControlState;
    exportRecordingFile(request: RecordingControlRequest): Promise<RecordingExportFileResult>;
    listPermissions(): AgentPermissionRequest[];
    resolvePermission(request: ResolvePermissionRequest): boolean;
    onPolicyDenied(notice: PolicyDenialNotice): void;
    onRendererUnavailable(): void;
    onSessionRemoved(sessionId: SessionId): void;
  };
  gateway: Pick<
    AgentGatewayOptions,
    "onActivity" | "onControlChanged" | "onPolicyDenied" | "requestPermission"
  >;
  dispose(): void;
};

export function createDesktopCollaborationServices({
  getGateway,
  sessions,
  showSaveDialog,
  broadcast,
  hasAvailableRenderer,
}: {
  getGateway: () => AgentGateway | null;
  sessions: Pick<TerminalSessionManager, "exportRecording">;
  showSaveDialog: RecordingExportDependencies["showSaveDialog"];
  broadcast: (event: RendererSessionEvent) => void;
  hasAvailableRenderer: () => boolean;
}): DesktopCollaborationServices {
  const permissionBroker = createPermissionBroker({
    onRequested: (payload) => broadcast({ type: "permission.requested", payload }),
    onResolved: (payload) => broadcast({ type: "permission.resolved", payload }),
  });

  return {
    renderer: {
      listAgentControls: () => getGateway()?.listSessionControls() ?? [],
      revokeAgentControl: (sessionId) =>
        getGateway()?.revokeSessionControl(sessionId) ?? {
          sessionId,
          state: "revoked",
          attachedAt: null,
        },
      allowAgentControl: (sessionId) =>
        getGateway()?.allowSessionControl(sessionId) ?? {
          sessionId,
          state: "detached",
          attachedAt: null,
        },
      exportRecordingFile: (request) =>
        exportRecordingToFile(request, {
          exportRecording: (recordingRequest) => sessions.exportRecording(recordingRequest),
          showSaveDialog,
        }),
      listPermissions: () => permissionBroker.list(),
      resolvePermission: (request) => permissionBroker.resolve(request),
      onPolicyDenied: (payload) => broadcast(createPolicyEvent(payload)),
      onRendererUnavailable: () => {
        if (!hasAvailableRenderer()) permissionBroker.cancelPending();
      },
      onSessionRemoved: (sessionId) => getGateway()?.removeSessionControl(sessionId),
    },
    gateway: {
      onActivity: (payload) => broadcast({ type: "agent.activity", payload }),
      onControlChanged: (payload) => broadcast({ type: "agent.control.changed", payload }),
      onPolicyDenied: (payload) => broadcast(createPolicyEvent(payload)),
      requestPermission: (prompt, signal) =>
        hasAvailableRenderer()
          ? permissionBroker.request(prompt, signal)
          : Promise.resolve("cancelled"),
    },
    dispose: () => permissionBroker.dispose(),
  };
}

function createPolicyEvent(
  payload: Extract<RendererSessionEvent, { type: "policy.denied" }>["payload"],
): Extract<RendererSessionEvent, { type: "policy.denied" }> {
  return { type: "policy.denied", payload };
}
