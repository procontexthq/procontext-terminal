import { TerminalApiError, type PolicyDenialNotice } from "@terminal/protocol";

export type UiNotification = {
  id: string;
  kind: "error" | "policy" | "success";
  title: string;
  message: string;
  at: string;
};

const maximumNotifications = 5;

export function addNotification(
  notifications: UiNotification[],
  notification: UiNotification,
): UiNotification[] {
  return [notification, ...notifications].slice(0, maximumNotifications);
}

export function notificationFromPolicyDenial(notice: PolicyDenialNotice): UiNotification {
  return {
    id: `policy-${notice.decisionId}`,
    kind: "policy",
    title: `${notice.actor === "agent" ? "Agent" : "Human"} action denied`,
    message: notice.message,
    at: notice.at,
  };
}

export function notificationFromError(error: unknown): UiNotification {
  return {
    id: `error-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    kind: "error",
    title: "Terminal action failed",
    message:
      error instanceof TerminalApiError
        ? error.terminalError.message
        : "The requested terminal action could not be completed.",
    at: new Date().toISOString(),
  };
}

export function isPolicyDenialError(error: unknown): boolean {
  return (
    error instanceof TerminalApiError &&
    (error.terminalError.type === "policy_denied" || error.terminalError.type === "auth_required")
  );
}

export function successNotification(title: string, message: string): UiNotification {
  return {
    id: `success-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    kind: "success",
    title,
    message,
    at: new Date().toISOString(),
  };
}
