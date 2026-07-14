import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as NodeFs from "node:fs";

import { createSessionId } from "@terminal/protocol";

const mocks = vi.hoisted(() => {
  type ExitEvent = { exitCode: number; signal?: number };
  type ExitHandler = (event: ExitEvent) => void;
  const exitHandlers: ExitHandler[] = [];
  const disposable = { dispose: vi.fn() };
  const processHandle = {
    pid: 123,
    cols: 80,
    rows: 24,
    process: "pwsh.exe",
    handleFlowControl: false,
    onData: vi.fn(() => disposable),
    onExit: vi.fn((handler: ExitHandler) => {
      exitHandlers.push(handler);
      return disposable;
    }),
    resize: vi.fn(),
    clear: vi.fn(),
    write: vi.fn(),
    kill: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  };
  return {
    exitHandlers,
    processHandle,
    spawn: vi.fn(() => processHandle),
  };
});

vi.mock("node-pty", () => ({
  default: { spawn: mocks.spawn },
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return { ...actual, accessSync: vi.fn() };
});

import { NodePtyHost } from "../src/index";

const originalPlatform = process.platform;

describe("Windows ConPTY hardening", () => {
  beforeAll(() => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
  });

  beforeEach(() => {
    mocks.exitHandlers.length = 0;
    vi.clearAllMocks();
  });

  afterAll(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
  });

  it("uses the operating-system ConPTY backend", async () => {
    await spawnWindowsPty();

    expect(mocks.spawn).toHaveBeenCalledWith(
      "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      [],
      expect.objectContaining({
        useConpty: true,
      }),
    );
    expect(mocks.spawn.mock.calls[0]?.[2]).not.toHaveProperty("useConptyDll");
  });

  it("does not kill a PTY again after its exit event", async () => {
    const session = await spawnWindowsPty();
    const exitHandler = mocks.exitHandlers[0];
    if (!exitHandler) throw new Error("Expected the PTY host to track process exit.");

    exitHandler({ exitCode: 0 });
    session.kill();

    expect(mocks.processHandle.kill).not.toHaveBeenCalled();
  });

  it("coalesces repeated kill requests", async () => {
    const session = await spawnWindowsPty();

    session.kill();
    session.kill();

    expect(mocks.processHandle.kill).toHaveBeenCalledOnce();
  });
});

async function spawnWindowsPty() {
  const host = new NodePtyHost();
  return await host.spawn({
    sessionId: createSessionId("windows-conpty"),
    shell: {
      executable: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      args: [],
      cwd: "C:\\workspace",
      env: {},
    },
    cols: 80,
    rows: 24,
  });
}
