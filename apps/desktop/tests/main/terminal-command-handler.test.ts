import { describe, expect, it, vi } from "vitest";

import { defaultTerminalConfig } from "@terminal/config";
import { createDefaultTerminalPolicy, type TerminalPolicy } from "@terminal/policy-engine";
import {
  createRendererCommand,
  createRequestId,
  createSessionId,
  createTerminalError,
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

  it("keeps canonical presentation aligned with the owning renderer's focused tab", async () => {
    const base = createServices();
    const denied = await handleRendererCommandPayload(
      createRendererCommand("session.reportViewFocus", { sessionId, focused: true }),
      base,
    );
    base.presentationRegistry.open(sessionId, 11);
    const foreground = await handleRendererCommandPayload(
      createRendererCommand("session.reportViewFocus", { sessionId, focused: true }),
      base,
    );
    const background = await handleRendererCommandPayload(
      createRendererCommand("session.reportViewFocus", { sessionId, focused: false }),
      base,
    );

    expect(denied).toMatchObject({ ok: false, error: { type: "view_unavailable" } });
    expect(foreground).toMatchObject({ ok: true });
    expect(background).toMatchObject({ ok: true });
    expect(base.sessionManager.setPresentation).toHaveBeenNthCalledWith(1, sessionId, {
      state: "foreground",
      windowVisible: true,
      windowFocused: true,
    });
    expect(base.sessionManager.setPresentation).toHaveBeenNthCalledWith(2, sessionId, {
      state: "background",
      windowVisible: true,
      windowFocused: false,
    });
  });

  it("removes presentation ownership only after a completed close", async () => {
    const base = createServices();
    base.presentationRegistry.open(sessionId, 11);
    vi.mocked(base.closeSession).mockResolvedValueOnce({
      status: "termination_pending",
    });

    await handleRendererCommandPayload(createRendererCommand("session.close", { sessionId }), base);
    expect(base.presentationRegistry.owns(sessionId, 11)).toBe(true);

    vi.mocked(base.closeSession).mockResolvedValueOnce({
      status: "closed",
      exitCode: 0,
      signal: null,
    });
    await handleRendererCommandPayload(createRendererCommand("session.close", { sessionId }), base);
    expect(base.presentationRegistry.owns(sessionId, 11)).toBe(false);
  });

  it("routes session close through the operation-aware close service", async () => {
    const closeSession = vi.fn(() =>
      Promise.resolve({
        status: "closed" as const,
        exitCode: 0,
        signal: null,
      }),
    );
    const base = { ...createServices(), closeSession };

    await handleRendererCommandPayload(createRendererCommand("session.close", { sessionId }), base);

    expect(closeSession).toHaveBeenCalledWith({ sessionId });
    expect(base.closeSession).toHaveBeenCalledOnce();
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

  it("lists and revokes privacy-safe agent control through the gateway boundary", async () => {
    const base = createServices();

    const listed = await handleRendererCommandPayload(
      createRendererCommand("agent.control.list", {}),
      base,
    );
    const revoked = await handleRendererCommandPayload(
      createRendererCommand("agent.control.revoke", { sessionId }),
      base,
    );
    const allowed = await handleRendererCommandPayload(
      createRendererCommand("agent.control.allow", { sessionId }),
      base,
    );

    expect(listed).toMatchObject({
      ok: true,
      value: [{ sessionId, state: "attached" }],
    });
    expect(revoked).toMatchObject({
      ok: true,
      value: { sessionId, state: "revoked", attachedAt: null },
    });
    expect(allowed).toMatchObject({
      ok: true,
      value: { sessionId, state: "detached", attachedAt: null },
    });
    expect(base.listAgentControls).toHaveBeenCalledOnce();
    expect(base.revokeAgentControl).toHaveBeenCalledWith(sessionId);
    expect(base.allowAgentControl).toHaveBeenCalledWith(sessionId);
  });

  it("validates session existence before changing agent control state", async () => {
    const base = createServices();
    vi.mocked(base.sessionManager.getSession).mockImplementation(() => {
      throw createTerminalError("session_not_found", "Missing session.", { sessionId });
    });

    const revoked = await handleRendererCommandPayload(
      createRendererCommand("agent.control.revoke", { sessionId }),
      base,
    );
    const allowed = await handleRendererCommandPayload(
      createRendererCommand("agent.control.allow", { sessionId }),
      base,
    );

    expect(revoked).toMatchObject({ ok: false, error: { type: "session_not_found" } });
    expect(allowed).toMatchObject({ ok: false, error: { type: "session_not_found" } });
    expect(base.revokeAgentControl).not.toHaveBeenCalled();
    expect(base.allowAgentControl).not.toHaveBeenCalled();
  });

  it("lists and resolves permission requests and saves focused agent policy settings", async () => {
    const base = createServices();
    const policy = {
      ...defaultTerminalConfig().agentPolicy,
      execution: "ask" as const,
      termination: "deny" as const,
    };

    const listed = await handleRendererCommandPayload(
      createRendererCommand("permission.list", {}),
      base,
    );
    const resolved = await handleRendererCommandPayload(
      createRendererCommand("permission.resolve", {
        permissionId: "decision-permission",
        decision: "allow",
      }),
      base,
    );
    const saved = await handleRendererCommandPayload(
      createRendererCommand("settings.saveAgentPolicy", { policy }),
      base,
    );

    expect(listed).toMatchObject({
      ok: true,
      value: [{ permissionId: "decision-permission", category: "termination" }],
    });
    expect(resolved).toMatchObject({ ok: true, value: true });
    expect(base.resolvePermission).toHaveBeenCalledWith({
      permissionId: "decision-permission",
      decision: "allow",
    });
    expect(saved).toMatchObject({ ok: true, value: { agentPolicy: policy } });
    expect(base.saveConfig).toHaveBeenCalledWith(expect.objectContaining({ agentPolicy: policy }));
  });

  it("routes native recording export and reports sanitized policy denials", async () => {
    const denial = {
      type: "deny" as const,
      decisionId: "decision-denied",
      reason: {
        decisionId: "decision-denied",
        code: "session_not_owned" as const,
        message: "Not attached.",
        operation: "recording.exportFile",
        sessionId,
      },
    };
    const policy: TerminalPolicy = { authorize: vi.fn(() => denial) };
    const deniedServices = createServices({ policy });

    const denied = await handleRendererCommandPayload(
      createRendererCommand("recording.exportFile", { sessionId }),
      deniedServices,
    );

    expect(denied).toMatchObject({ ok: false, error: { type: "policy_denied" } });
    const onPolicyDenied = deniedServices.onPolicyDenied;
    if (!onPolicyDenied) throw new Error("Expected policy denial callback.");
    const notice = vi.mocked(onPolicyDenied).mock.calls[0]?.[0];
    expect(notice).toMatchObject({
      decisionId: "decision-denied",
      actor: "human",
      operation: "recording.exportFile",
      sessionId,
      code: "session_not_owned",
      message: "Not attached.",
    });
    expect(typeof notice?.at).toBe("string");

    const allowedServices = createServices();
    const exported = await handleRendererCommandPayload(
      createRendererCommand("recording.exportFile", { sessionId }),
      allowedServices,
    );
    expect(exported).toMatchObject({
      ok: true,
      value: { status: "saved", fileName: "recording.json" },
    });
    expect(allowedServices.exportRecordingFile).toHaveBeenCalledWith({ sessionId });
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
      scroll: vi.fn(() => Promise.resolve({ status: "unchanged" as const, observationVersion: 2 })),
      getViewBootstrap: vi.fn(() => ({
        session: summary,
        serialized: "serialized framebuffer",
        sequence: 7,
        viewportY: 3,
      })),
      setPresentation: vi.fn(() => Promise.resolve()),
      reportViewport: vi.fn(() => Promise.resolve(true)),
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
    closeSession: vi.fn(() =>
      Promise.resolve({
        status: "closed" as const,
        exitCode: 0,
        signal: null,
      }),
    ),
    listAgentControls: vi.fn(() => [
      {
        sessionId,
        state: "attached" as const,
        attachedAt: "2026-07-14T00:00:00.000Z",
      },
    ]),
    revokeAgentControl: vi.fn(() => ({
      sessionId,
      state: "revoked" as const,
      attachedAt: null,
    })),
    allowAgentControl: vi.fn(() => ({
      sessionId,
      state: "detached" as const,
      attachedAt: null,
    })),
    listPermissions: vi.fn(() => [
      {
        permissionId: "decision-permission",
        category: "termination" as const,
        operation: "terminal.close",
        sessionId,
        requestedAt: "2026-07-14T00:00:00.000Z",
        expiresAt: "2026-07-14T00:00:30.000Z",
      },
    ]),
    resolvePermission: vi.fn(() => true),
    exportRecordingFile: vi.fn(() =>
      Promise.resolve({ status: "saved" as const, fileName: "recording.json" }),
    ),
    onPolicyDenied: vi.fn(),
    getConfig: defaultTerminalConfig,
    saveConfig: vi.fn((config) => Promise.resolve(config)),
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
