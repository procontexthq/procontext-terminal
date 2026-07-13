import { describe, expect, it, vi } from "vitest";

import { defaultTerminalConfig } from "@terminal/config";
import { createDefaultTerminalPolicy, type TerminalPolicy } from "@terminal/policy-engine";
import {
  createRendererCommand,
  createRequestId,
  createSessionId,
  type TerminalConfig,
  type TerminalSessionSummary,
} from "@terminal/protocol";

import {
  handleRendererCommandPayload,
  type TerminalCommandServices,
} from "../../src/main/terminal-command-handler";
import { createTerminalPresentationRegistry } from "../../src/main/presentation-registry";

const sessionId = createSessionId("session-1");

describe("terminal command handler", () => {
  it("creates human sessions with the configured shell profile", async () => {
    const base = createServices();
    const config: TerminalConfig = {
      ...defaultTerminalConfig(),
      shell: {
        defaultProfile: "work",
        profiles: [
          {
            id: "work",
            name: "Work",
            shell: "/bin/zsh",
            cwd: "/workspace",
            env: { TERM_PROGRAM: "procontext" },
          },
        ],
      },
    };
    base.getConfig = () => config;

    const result = await handleRendererCommandPayload(
      createRendererCommand("session.create", { cols: 100, rows: 30 }),
      base,
    );

    expect(result).toMatchObject({ ok: true, value: { sessionId } });
    expect(base.sessionManager.createSession).toHaveBeenCalledWith({
      cols: 100,
      rows: 30,
      shell: "/bin/zsh",
      cwd: "/workspace",
      env: { TERM_PROGRAM: "procontext" },
      createdBy: "human",
    });
  });

  it("routes raw renderer input with human origin", async () => {
    const base = createServices();

    await handleRendererCommandPayload(
      createRendererCommand("session.input", { sessionId, input: "\u0003", origin: "agent" }),
      base,
    );

    expect(base.sessionManager.input).toHaveBeenCalledWith({
      sessionId,
      input: "\u0003",
      origin: "human",
    });
  });

  it("opens one canonical renderer view and returns its serialized bootstrap", async () => {
    const base = createServices();

    const result = await handleRendererCommandPayload(
      createRendererCommand("session.openView", { sessionId }),
      base,
    );

    expect(result).toMatchObject({
      ok: true,
      value: { serialized: "serialized framebuffer", sequence: 7 },
    });
    expect(base.presentationRegistry.owns(sessionId, 11)).toBe(true);
    expect(base.sessionManager.setPresentation).toHaveBeenCalledWith(sessionId, {
      state: "background",
      windowVisible: true,
      windowFocused: false,
    });
  });

  it("returns a view to headless presentation when its owning renderer closes it", async () => {
    const base = createServices();
    base.presentationRegistry.open(sessionId, 11);

    await handleRendererCommandPayload(
      createRendererCommand("session.closeView", { sessionId }),
      base,
    );

    expect(base.presentationRegistry.owns(sessionId, 11)).toBe(false);
    expect(base.sessionManager.setPresentation).toHaveBeenCalledWith(sessionId, {
      state: "headless",
      windowVisible: false,
      windowFocused: false,
    });
  });

  it("accepts viewport reports only from the renderer that owns the view", async () => {
    const base = createServices();
    const denied = await handleRendererCommandPayload(
      createRendererCommand("session.reportViewport", { sessionId, viewportY: 4 }),
      base,
    );
    base.presentationRegistry.open(sessionId, 11);
    const allowed = await handleRendererCommandPayload(
      createRendererCommand("session.reportViewport", { sessionId, viewportY: 4 }),
      base,
    );

    expect(denied).toMatchObject({ ok: false, error: { type: "view_unavailable" } });
    expect(allowed).toMatchObject({ ok: true });
    expect(base.sessionManager.reportViewport).toHaveBeenCalledWith({ sessionId, viewportY: 4 });
  });

  it("removes presentation ownership only after a completed close", async () => {
    const base = createServices();
    base.presentationRegistry.open(sessionId, 11);
    vi.mocked(base.sessionManager.close).mockResolvedValueOnce({
      status: "termination_pending",
    });

    await handleRendererCommandPayload(createRendererCommand("session.close", { sessionId }), base);
    expect(base.presentationRegistry.owns(sessionId, 11)).toBe(true);

    vi.mocked(base.sessionManager.close).mockResolvedValueOnce({
      status: "closed",
      exitCode: 0,
      signal: null,
    });
    await handleRendererCommandPayload(createRendererCommand("session.close", { sessionId }), base);
    expect(base.presentationRegistry.owns(sessionId, 11)).toBe(false);
  });

  it("authorizes recording before invoking recorder operations", async () => {
    const policy: TerminalPolicy = {
      authorize: vi.fn<TerminalPolicy["authorize"]>(() => ({
        type: "allow",
        decisionId: "decision-1",
      })),
    };
    const base = createServices({ policy });

    await handleRendererCommandPayload(
      createRendererCommand("recording.start", { sessionId }),
      base,
    );

    expect(policy.authorize).toHaveBeenCalledWith({
      actor: { kind: "human", local: true },
      operation: { type: "recording.start", sessionId, recordingKind: "start" },
    });
    expect(base.sessionManager.startRecording).toHaveBeenCalledWith({ sessionId });
  });

  it("routes renderer presentation readiness and acknowledgements", async () => {
    const base = createServices();
    const commandId = createRequestId("presentation-command");

    await handleRendererCommandPayload(createRendererCommand("presentation.ready", {}), base);
    await handleRendererCommandPayload(
      createRendererCommand("presentation.acknowledge", {
        commandId,
        sessionId,
        action: "open",
        status: "completed",
      }),
      base,
    );

    expect(base.presentationController.rendererReady).toHaveBeenCalledWith(11);
    expect(base.presentationController.acknowledge).toHaveBeenCalledWith(11, {
      commandId,
      sessionId,
      action: "open",
      status: "completed",
    });
  });

  it("rejects obsolete renderer commands at the protocol boundary", async () => {
    const result = await handleRendererCommandPayload(
      {
        type: "session.captureScreen",
        requestId: "request-obsolete",
        payload: { sessionId },
      },
      createServices(),
    );

    expect(result).toMatchObject({ ok: false, error: { type: "invalid_request" } });
  });
});

function createServices(overrides: { policy?: TerminalPolicy } = {}): TerminalCommandServices {
  const summary = createSummary();
  return {
    rendererId: 11,
    presentationRegistry: createTerminalPresentationRegistry(),
    presentationController: {
      setPresentation: vi.fn(),
      closeView: vi.fn(),
      rendererReady: vi.fn(),
      acknowledge: vi.fn(),
      rendererUnavailable: vi.fn(),
    },
    sessionManager: {
      createSession: vi.fn(() => Promise.resolve(summary)),
      listSessions: vi.fn(() => [summary]),
      getSession: vi.fn(() => summary),
      input: vi.fn(() => Promise.resolve({ accepted: true as const, observationVersion: 1 })),
      resize: vi.fn(() => Promise.resolve({ observationVersion: 2 })),
      scroll: vi.fn(() => ({ status: "unchanged" as const, observationVersion: 2 })),
      close: vi.fn(() =>
        Promise.resolve({
          status: "closed" as const,
          exitCode: 0,
          signal: null,
        }),
      ),
      getViewBootstrap: vi.fn(() => ({
        session: summary,
        serialized: "serialized framebuffer",
        sequence: 7,
        viewportY: 3,
      })),
      setPresentation: vi.fn(),
      reportViewport: vi.fn(() => true),
      startRecording: vi.fn(() => Promise.resolve()),
      stopRecording: vi.fn(() => Promise.resolve()),
      exportRecording: vi.fn(() =>
        Promise.resolve({
          schemaVersion: 1 as const,
          sessionId,
          exportedAt: "2026-07-13T00:00:00.000Z",
          events: [],
        }),
      ),
    },
    getConfig: defaultTerminalConfig,
    saveConfig: (config) => Promise.resolve(config),
    policy: overrides.policy ?? createDefaultTerminalPolicy(),
  };
}

function createSummary(): TerminalSessionSummary {
  return {
    sessionId,
    lifecycle: "running",
    shell: "/bin/sh",
    cwd: "/tmp",
    dimensions: { cols: 80, rows: 24 },
    title: null,
    createdBy: "human",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    observationVersion: 1,
    presentation: {
      state: "headless",
      windowVisible: false,
      windowFocused: false,
    },
    shellIntegration: {
      status: "unavailable",
      capabilities: {
        prompt: false,
        commandStart: false,
        commandFinish: false,
        commandLine: false,
        exitCode: false,
        cwd: false,
      },
    },
    command: { state: "unknown" },
    recording: { state: "inactive" },
  };
}
