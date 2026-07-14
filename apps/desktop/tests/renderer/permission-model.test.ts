import { describe, expect, it } from "vitest";

import type { RendererSessionEvent } from "@terminal/protocol";

import { applyPermissionEvent, createPermissionQueue } from "../../src/renderer/permission-model";

describe("permission model", () => {
  it("adds privacy-safe requests once and removes them when resolved", () => {
    const requested: RendererSessionEvent = {
      type: "permission.requested",
      payload: {
        permissionId: "decision-model",
        category: "execution",
        operation: "terminal.run",
        requestedAt: "2026-07-14T00:00:00.000Z",
        expiresAt: "2026-07-14T00:00:30.000Z",
      },
    };
    const pending = applyPermissionEvent(
      applyPermissionEvent(createPermissionQueue([]), requested),
      requested,
    );

    expect(pending).toHaveLength(1);
    expect(
      applyPermissionEvent(pending, {
        type: "permission.resolved",
        payload: { permissionId: "decision-model", outcome: "deny" },
      }),
    ).toEqual([]);
  });

  it("keeps the in-memory queue bounded", () => {
    const requests = Array.from({ length: 25 }, (_, index) => ({
      permissionId: `decision-${index}`,
      category: "observation" as const,
      operation: "terminal.list",
      requestedAt: "2026-07-14T00:00:00.000Z",
      expiresAt: "2026-07-14T00:00:30.000Z",
    }));

    expect(createPermissionQueue(requests)).toHaveLength(20);
  });
});
