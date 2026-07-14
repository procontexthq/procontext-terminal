import { describe, expect, it, vi } from "vitest";

import { createDesktopCollaborationServices } from "../../src/main/collaboration-services";

describe("desktop collaboration services", () => {
  it("bridges permission requests and first renderer resolutions with sanitized events", async () => {
    const broadcast = vi.fn();
    const services = createDesktopCollaborationServices({
      getGateway: () => null,
      sessions: { exportRecording: vi.fn() },
      showSaveDialog: vi.fn(),
      broadcast,
      hasAvailableRenderer: () => true,
    });
    const requestPermission = services.gateway.requestPermission;
    if (!requestPermission) throw new Error("Expected permission request service.");

    const pending = requestPermission(
      {
        decisionId: "decision-collaboration",
        category: "execution",
        operation: "terminal.run",
      },
      new AbortController().signal,
    );

    expect(services.renderer.listPermissions()).toEqual([
      expect.objectContaining({
        permissionId: "decision-collaboration",
        category: "execution",
        operation: "terminal.run",
      }),
    ]);
    expect(
      services.renderer.resolvePermission({
        permissionId: "decision-collaboration",
        decision: "deny",
      }),
    ).toBe(true);
    await expect(pending).resolves.toBe("deny");
    expect(broadcast).toHaveBeenCalledWith({
      type: "permission.resolved",
      payload: { permissionId: "decision-collaboration", outcome: "deny" },
    });
    expect(JSON.stringify(broadcast.mock.calls)).not.toContain("connectionId");
    services.dispose();
  });

  it("denies immediately when no renderer can display a permission request", async () => {
    const broadcast = vi.fn();
    const services = createDesktopCollaborationServices({
      getGateway: () => null,
      sessions: { exportRecording: vi.fn() },
      showSaveDialog: vi.fn(),
      broadcast,
      hasAvailableRenderer: () => false,
    });
    const requestPermission = services.gateway.requestPermission;
    if (!requestPermission) throw new Error("Expected permission request service.");

    await expect(
      requestPermission(
        {
          decisionId: "decision-unavailable",
          category: "execution",
          operation: "terminal.create",
        },
        new AbortController().signal,
      ),
    ).resolves.toBe("cancelled");

    expect(services.renderer.listPermissions()).toEqual([]);
    expect(broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "permission.requested" }),
    );
    services.dispose();
  });

  it("cancels pending requests when the last renderer becomes unavailable", async () => {
    let rendererAvailable = true;
    const broadcast = vi.fn();
    const services = createDesktopCollaborationServices({
      getGateway: () => null,
      sessions: { exportRecording: vi.fn() },
      showSaveDialog: vi.fn(),
      broadcast,
      hasAvailableRenderer: () => rendererAvailable,
    });
    const requestPermission = services.gateway.requestPermission;
    if (!requestPermission) throw new Error("Expected permission request service.");
    const pending = requestPermission(
      {
        decisionId: "decision-renderer-lost",
        category: "termination",
        operation: "terminal.close",
      },
      new AbortController().signal,
    );

    rendererAvailable = false;
    services.renderer.onRendererUnavailable();

    await expect(pending).resolves.toBe("cancelled");
    expect(services.renderer.listPermissions()).toEqual([]);
    expect(broadcast).toHaveBeenCalledWith({
      type: "permission.resolved",
      payload: { permissionId: "decision-renderer-lost", outcome: "cancelled" },
    });
    services.dispose();
  });
});
