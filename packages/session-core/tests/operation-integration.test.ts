import { describe, expect, it, vi } from "vitest";

import { NodePtyHost } from "@terminal/pty-host";

import {
  NodeCapturedProcessHost,
  TerminalOperationManager,
  TerminalSessionManager,
} from "../src/index";

describe("terminal operation integration", () => {
  it("runs captured and temporary PTY commands through the public core boundary", async () => {
    const sessions = new TerminalSessionManager(new NodePtyHost());
    const manager = new TerminalOperationManager(new NodeCapturedProcessHost(), sessions, {
      defaultCwd: () => process.cwd(),
      onBackgroundError: vi.fn(),
    });

    const captured = await manager.run({
      input: nodeEvalCommand(
        'process.stdout.write("CAPTURED_OUT"); process.stderr.write("CAPTURED_ERR");',
      ),
      tty: false,
      timeoutMs: 5_000,
    });
    expect(captured).toMatchObject({
      status: "completed",
      tty: false,
      exitCode: 0,
      stdout: "CAPTURED_OUT",
      stderr: "CAPTURED_ERR",
    });

    const terminal = await manager.run({
      input: nodeEvalCommand('process.stdout.write("PTY_OUT");'),
      tty: true,
      timeoutMs: 5_000,
    });
    expect(terminal).toMatchObject({
      status: "completed",
      tty: true,
      exitCode: 0,
    });
    if (!terminal.tty) throw new Error("Expected a terminal run.");
    expect(terminal.output).toContain("PTY_OUT");

    await expect(manager.close({ operationId: captured.operationId })).resolves.toMatchObject({
      status: "closed",
    });
    await expect(manager.close({ operationId: terminal.operationId })).resolves.toMatchObject({
      status: "closed",
    });
  });
});

function nodeEvalCommand(source: string): string {
  const encoded = Buffer.from(source, "utf8").toString("base64");
  return `node -e "eval(Buffer.from('${encoded}', 'base64').toString('utf8'))"`;
}
