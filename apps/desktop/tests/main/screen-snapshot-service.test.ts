import { describe, expect, it, vi } from "vitest";

import {
  createRequestId,
  createSessionId,
  type GetSessionRequest,
  type RendererSessionEvent,
  type TerminalSessionSnapshot,
} from "@terminal/protocol";

import {
  cleanupRendererOwnership,
  createScreenSnapshotService,
  detachOrphanedRendererSessions,
} from "../../src/main/ipc";

const sessionId = createSessionId("session-observed");
const otherSessionId = createSessionId("session-other");

describe("screen snapshot service", () => {
  it("returns observation_unavailable when no renderer owns the requested session", async () => {
    const service = createScreenSnapshotService({
      getRendererCount: () => 1,
      sendSnapshotRequest: () => undefined,
    });

    await expect(service.requestScreenSnapshot(sessionId, 50)).rejects.toMatchObject({
      type: "observation_unavailable",
      sessionId,
      operation: "session.captureScreen",
      cause: "No renderer owns the requested session.",
    });
  });

  it("sends snapshot requests only to registered renderer owners", async () => {
    const sent: Array<{ event: RendererSessionEvent; rendererIds: readonly number[] }> = [];
    const service = createScreenSnapshotService({
      getRendererCount: () => 2,
      sendSnapshotRequest: (event, rendererIds) => {
        sent.push({ event, rendererIds: [...rendererIds] });
      },
    });
    service.registerRendererSession(sessionId, 7);

    const pending = service.requestScreenSnapshot(sessionId, 1000);
    const request = sent[0]?.event;
    if (!request || request.type !== "session.snapshot.request") {
      throw new Error("Expected snapshot request to be sent to the owning renderer.");
    }
    service.resolveSnapshotResponse(request.requestId, {
      sessionId,
      cols: 80,
      rows: 24,
      cursor: { x: 0, y: 0, visible: true },
      alternateScreen: false,
      title: null,
      viewport: [],
      capturedAt: "2026-06-10T00:00:00.000Z",
    });

    await expect(pending).resolves.toMatchObject({ sessionId });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.event).toMatchObject({
      type: "session.snapshot.request",
      payload: { sessionId },
    });
    expect(sent[0]?.rendererIds).toEqual([7]);
  });

  it("rejects mismatched snapshot responses instead of resolving the pending request", async () => {
    let requestId = createRequestId("missing");
    const service = createScreenSnapshotService({
      getRendererCount: () => 1,
      sendSnapshotRequest: (event) => {
        requestId = event.requestId;
      },
    });
    service.registerRendererSession(sessionId, 7);

    const pending = service.requestScreenSnapshot(sessionId, 1000);
    service.resolveSnapshotResponse(requestId, {
      sessionId: otherSessionId,
      cols: 80,
      rows: 24,
      cursor: { x: 0, y: 0, visible: true },
      alternateScreen: false,
      title: null,
      viewport: [],
      capturedAt: "2026-06-10T00:00:00.000Z",
    });

    await expect(pending).rejects.toMatchObject({
      type: "session_snapshot_failed",
      sessionId,
      operation: "session.captureScreen",
      cause: "Snapshot response session mismatch.",
    });
  });

  it("rejects explicit renderer unavailable responses with observation_unavailable", async () => {
    let requestId = createRequestId("missing");
    const service = createScreenSnapshotService({
      getRendererCount: () => 1,
      sendSnapshotRequest: (event) => {
        requestId = event.requestId;
      },
    });
    service.registerRendererSession(sessionId, 7);

    const pending = service.requestScreenSnapshot(sessionId, 1000);
    service.rejectSnapshotResponse(requestId, sessionId, "Terminal snapshot is unavailable.");

    await expect(pending).rejects.toMatchObject({
      type: "observation_unavailable",
      sessionId,
      operation: "session.captureScreen",
      cause: "Terminal snapshot is unavailable.",
    });
  });

  it("rejects mismatched renderer unavailable responses as snapshot protocol failures", async () => {
    let requestId = createRequestId("missing");
    const service = createScreenSnapshotService({
      getRendererCount: () => 1,
      sendSnapshotRequest: (event) => {
        requestId = event.requestId;
      },
    });
    service.registerRendererSession(sessionId, 7);

    const pending = service.requestScreenSnapshot(sessionId, 1000);
    service.rejectSnapshotResponse(requestId, otherSessionId, "Wrong session.");

    await expect(pending).rejects.toMatchObject({
      type: "session_snapshot_failed",
      sessionId,
      operation: "session.captureScreen",
      cause: "Snapshot unavailable session mismatch.",
    });
  });

  it("returns only sessions orphaned by renderer cleanup", async () => {
    const sent: Array<{ event: RendererSessionEvent; rendererIds: readonly number[] }> = [];
    const service = createScreenSnapshotService({
      getRendererCount: () => 2,
      sendSnapshotRequest: (event, rendererIds) => {
        sent.push({ event, rendererIds: [...rendererIds] });
      },
    });
    service.registerRendererSession(sessionId, 7);
    service.registerRendererSession(otherSessionId, 7);
    service.registerRendererSession(otherSessionId, 8);

    expect(service.unregisterRenderer(7)).toEqual([sessionId]);

    await expect(service.requestScreenSnapshot(sessionId, 50)).rejects.toMatchObject({
      type: "observation_unavailable",
      cause: "No renderer owns the requested session.",
    });

    const pending = service.requestScreenSnapshot(otherSessionId, 1000);
    const request = sent[0]?.event;
    if (!request || request.type !== "session.snapshot.request") {
      throw new Error("Expected snapshot request for the remaining renderer owner.");
    }
    expect(sent[0]?.rendererIds).toEqual([8]);
    service.resolveSnapshotResponse(request.requestId, {
      sessionId: otherSessionId,
      cols: 80,
      rows: 24,
      cursor: { x: 0, y: 0, visible: true },
      alternateScreen: false,
      title: null,
      viewport: [],
      capturedAt: "2026-06-10T00:00:00.000Z",
    });
    await expect(pending).resolves.toMatchObject({ sessionId: otherSessionId });
  });

  it("rejects pending snapshot requests when the last renderer owner disappears", async () => {
    const service = createScreenSnapshotService({
      getRendererCount: () => 1,
      sendSnapshotRequest: () => undefined,
    });
    service.registerRendererSession(sessionId, 7);

    const pending = service.requestScreenSnapshot(sessionId, 1000);

    expect(service.unregisterRenderer(7)).toEqual([sessionId]);
    await expect(pending).rejects.toMatchObject({
      type: "observation_unavailable",
      sessionId,
      operation: "session.captureScreen",
      cause: "No renderer owns the requested session.",
    });
  });

  it("detaches running orphaned sessions when their renderer disappears", () => {
    const detachSession = vi.fn();
    const getSession = vi.fn(
      ({ sessionId: requestedSessionId }: GetSessionRequest): TerminalSessionSnapshot => ({
        sessionId: requestedSessionId,
        state: requestedSessionId === sessionId ? "running" : "detached",
        shell: "/bin/sh",
        cwd: "/tmp",
        cols: 80,
        rows: 24,
        title: null,
        createdBy: "agent",
        createdAt: "2026-06-10T00:00:00.000Z",
        updatedAt: "2026-06-10T00:00:00.000Z",
      }),
    );
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };

    detachOrphanedRendererSessions({
      sessionIds: [sessionId, otherSessionId],
      sessionManager: {
        getSession,
        detachSession,
      },
      rendererId: 7,
      logger,
    });

    expect(detachSession).toHaveBeenCalledWith({ sessionId });
    expect(detachSession).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("cleans renderer ownership and detaches orphaned sessions through one crash cleanup path", () => {
    const detachSession = vi.fn();
    const unregisterRenderer = vi.fn(() => [sessionId]);
    const getSession = vi.fn(
      ({ sessionId: requestedSessionId }: GetSessionRequest): TerminalSessionSnapshot => ({
        sessionId: requestedSessionId,
        state: "running",
        shell: "/bin/sh",
        cwd: "/tmp",
        cols: 80,
        rows: 24,
        title: null,
        createdBy: "human",
        createdAt: "2026-06-10T00:00:00.000Z",
        updatedAt: "2026-06-10T00:00:00.000Z",
      }),
    );
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };

    cleanupRendererOwnership({
      screenSnapshotService: { unregisterRenderer },
      sessionManager: { getSession, detachSession },
      rendererId: 7,
      logger,
    });

    expect(unregisterRenderer).toHaveBeenCalledWith(7);
    expect(detachSession).toHaveBeenCalledWith({ sessionId });
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
