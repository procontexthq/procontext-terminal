// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSessionId } from "@terminal/protocol";

import { PermissionCenter } from "../../src/renderer/permission-center";

describe("PermissionCenter", () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it("shows safe approval metadata and routes allow-once and deny actions", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onResolve = vi.fn();

    act(() => {
      root.render(
        createElement(PermissionCenter, {
          requests: [
            {
              permissionId: "decision-ui",
              category: "termination",
              operation: "terminal.close",
              sessionId: createSessionId("session-ui"),
              requestedAt: "2026-07-14T00:00:00.000Z",
              expiresAt: "2026-07-14T00:00:30.000Z",
            },
          ],
          onResolve,
        }),
      );
    });

    expect(container.textContent).toContain("Agent requests termination");
    expect(container.textContent).toContain("terminal.close");
    expect(container.textContent).not.toContain("SECRET_COMMAND");
    const buttons = Array.from(container.querySelectorAll("button"));
    act(() => {
      buttons.find((button) => button.textContent === "Allow once")?.click();
      buttons.find((button) => button.textContent === "Deny")?.click();
    });
    expect(onResolve).toHaveBeenCalledWith("decision-ui", "allow");
    expect(onResolve).toHaveBeenCalledWith("decision-ui", "deny");

    act(() => root.unmount());
  });
});
