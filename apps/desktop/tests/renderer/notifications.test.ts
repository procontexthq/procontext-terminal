import { describe, expect, it } from "vitest";

import { TerminalApiError, createRequestId, createTerminalError } from "@terminal/protocol";

import {
  addNotification,
  isPolicyDenialError,
  notificationFromError,
  notificationFromPolicyDenial,
  successNotification,
  type UiNotification,
} from "../../src/renderer/notifications";

describe("renderer notifications", () => {
  it("keeps a bounded newest-first in-memory list", () => {
    let notifications: UiNotification[] = [];
    for (let index = 0; index < 7; index += 1) {
      notifications = addNotification(
        notifications,
        successNotification(`Notice ${index}`, "Complete"),
      );
    }

    expect(notifications).toHaveLength(5);
    expect(notifications[0]?.title).toBe("Notice 6");
  });

  it("uses typed safe errors and hides arbitrary unknown error details", () => {
    const typed = notificationFromError(
      new TerminalApiError(
        createRequestId("request-notification"),
        createTerminalError("policy_denied", "Agent input is not permitted."),
      ),
    );
    const unknown = notificationFromError(new Error("SECRET_COMMAND_OUTPUT"));

    expect(typed.message).toBe("Agent input is not permitted.");
    expect(unknown.message).not.toContain("SECRET_COMMAND_OUTPUT");
    expect(
      isPolicyDenialError(
        new TerminalApiError(
          createRequestId("request-policy"),
          createTerminalError("policy_denied", "Denied."),
        ),
      ),
    ).toBe(true);
  });

  it("maps sanitized policy notices without adding request or connection metadata", () => {
    const notification = notificationFromPolicyDenial({
      decisionId: "decision-notice",
      at: "2026-07-14T00:00:00.000Z",
      actor: "agent",
      operation: "terminal.input",
      code: "session_not_owned",
      message: "Agent connection is not attached to this terminal session.",
    });

    expect(notification).toMatchObject({
      kind: "policy",
      title: "Agent action denied",
      message: "Agent connection is not attached to this terminal session.",
    });
  });
});
