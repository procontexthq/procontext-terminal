import type {
  PermissionResolutionOutcome,
  PolicyDenialCode,
  PolicyPrompt,
} from "@terminal/protocol";

export async function requestAgentPermission(
  requestPermission:
    | ((prompt: PolicyPrompt, signal: AbortSignal) => Promise<PermissionResolutionOutcome>)
    | undefined,
  prompt: PolicyPrompt,
  signal: AbortSignal,
): Promise<PermissionResolutionOutcome> {
  if (!requestPermission) return "cancelled";
  try {
    return await requestPermission(prompt, signal);
  } catch {
    return "cancelled";
  }
}

export function permissionDenialCode(
  outcome: Exclude<PermissionResolutionOutcome, "allow">,
): PolicyDenialCode {
  switch (outcome) {
    case "deny":
      return "permission_denied";
    case "timeout":
      return "permission_timeout";
    case "cancelled":
      return "permission_unavailable";
  }
}

export function permissionDenialMessage(code: PolicyDenialCode): string {
  switch (code) {
    case "permission_denied":
      return "Agent operation was denied by the human operator.";
    case "permission_timeout":
      return "Agent permission request timed out.";
    case "permission_unavailable":
      return "Agent permission approval is unavailable.";
    case "auth_required":
      return "Agent authentication is required.";
    case "remote_control_disabled":
      return "Remote agent control is disabled.";
    case "session_not_owned":
      return "Agent connection is not attached to this terminal session.";
    case "session_in_use":
      return "Another agent connection controls this terminal session.";
    case "agent_control_revoked":
      return "Agent control has been revoked for this terminal session.";
  }
}
