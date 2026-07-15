import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as NodeFs from "node:fs";

import { createSessionId } from "@terminal/protocol";

const mocks = vi.hoisted(() => {
  type DataHandler = (data: string) => void;
  type ExitEvent = { exitCode: number; signal?: number };
  type ExitHandler = (event: ExitEvent) => void;
  const dataHandlers: DataHandler[] = [];
  const exitHandlers: ExitHandler[] = [];
  const disposable = { dispose: vi.fn() };
  const processHandle = {
    pid: 123,
    cols: 80,
    rows: 24,
    process: "pwsh.exe",
    handleFlowControl: false,
    onData: vi.fn((handler: DataHandler) => {
      dataHandlers.push(handler);
      return disposable;
    }),
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
    dataHandlers,
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
    mocks.dataHandlers.length = 0;
    mocks.exitHandlers.length = 0;
    vi.clearAllMocks();
  });

  afterAll(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
  });

  it("uses the bundled ConPTY backend", async () => {
    await spawnWindowsPty();

    expect(mocks.spawn).toHaveBeenCalledWith(
      "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      [],
      expect.objectContaining({
        useConptyDll: true,
      }),
    );
  });

  it("answers and removes the bundled console startup query once", async () => {
    const session = await spawnWindowsPty();
    const dataHandler = mocks.dataHandlers[0];
    if (!dataHandler) {
      throw new Error("Expected the PTY host to subscribe before returning the session.");
    }

    dataHandler("\u001b[1t\u001b[");
    dataHandler("c\u001b[?1004h");
    const output = vi.fn<(data: string) => void>();
    session.onData(output);
    dataHandler("later\u001b[c");

    expect(mocks.processHandle.write).toHaveBeenCalledOnce();
    expect(mocks.processHandle.write).toHaveBeenCalledWith("\u001b[?1;2c");
    expect(output.mock.calls.map(([data]) => data)).toEqual([
      "\u001b[1t",
      "\u001b[?1004h",
      "later\u001b[c",
    ]);
  });

  it("does not truncate output emitted before the first subscriber attaches", async () => {
    const session = await spawnWindowsPty();
    const dataHandler = mocks.dataHandlers[0];
    if (!dataHandler) {
      throw new Error("Expected the PTY host to subscribe before returning the session.");
    }
    const firstOutput = "x".repeat(64 * 1024);
    dataHandler(firstOutput);
    dataHandler("after-buffer-threshold");

    const output = vi.fn<(data: string) => void>();
    session.onData(output);

    expect(output.mock.calls.map(([data]) => data).join("")).toBe(
      `${firstOutput}after-buffer-threshold`,
    );
  });

  it("keeps duplicate callback subscriptions independent", async () => {
    const session = await spawnWindowsPty();
    const dataHandler = mocks.dataHandlers[0];
    if (!dataHandler) {
      throw new Error("Expected the PTY host to subscribe before returning the session.");
    }
    dataHandler("x".repeat(64));
    const output = vi.fn<(data: string) => void>();
    const unsubscribeFirst = session.onData(output);
    const unsubscribeSecond = session.onData(output);

    dataHandler("both");
    unsubscribeFirst();
    dataHandler("second-only");
    unsubscribeSecond();
    dataHandler("neither");

    expect(output.mock.calls.map(([data]) => data)).toEqual([
      "x".repeat(64),
      "both",
      "both",
      "second-only",
    ]);
  });

  it("does not kill a PTY again after its exit event", async () => {
    const session = await spawnWindowsPty();
    const exitHandler = mocks.exitHandlers[0];
    if (!exitHandler) throw new Error("Expected the PTY host to track process exit.");

    exitHandler({ exitCode: 0 });
    session.kill();

    expect(mocks.processHandle.kill).not.toHaveBeenCalled();
  });

  it("marks the PTY exited before flushing a partial startup query", async () => {
    const session = await spawnWindowsPty();
    const dataHandler = mocks.dataHandlers[0];
    const exitHandler = mocks.exitHandlers[0];
    if (!dataHandler || !exitHandler) {
      throw new Error("Expected the PTY host to track process output and exit.");
    }
    session.onData(() => session.kill());
    dataHandler("\u001b[");

    exitHandler({ exitCode: 0 });

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
