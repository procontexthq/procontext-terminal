import { describe, expect, it } from "vitest";

import { createSessionId } from "@terminal/protocol";

import { NodePtyHost, resolveShell } from "../src/index";

describe.skipIf(process.platform !== "win32")("Windows ConPTY transport", () => {
  it("preserves OSC control sequences from a real PowerShell PTY", async () => {
    const marker = "\u001b]633;PCT_TRANSPORT\u001b\\";
    const session = await new NodePtyHost().spawn({
      sessionId: createSessionId("windows-osc"),
      shell: resolveShell({ shell: "powershell.exe", cwd: process.cwd() }),
      cols: 80,
      rows: 24,
    });

    const output = outputUntilExit(session);
    session.write("$e=[char]27; [Console]::Write($e + ']633;PCT_TRANSPORT' + $e + '\\'); exit\r");

    await expect(output).resolves.toContain(marker);
  });
});

function outputUntilExit(session: Awaited<ReturnType<NodePtyHost["spawn"]>>): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    let unsubscribeData = (): void => {};
    let unsubscribeExit = (): void => {};
    const timeout = setTimeout(() => {
      try {
        session.kill();
        finish(new Error("Timed out waiting for OSC output from Windows ConPTY."));
      } catch (error: unknown) {
        finish(
          new Error("Timed out waiting for OSC output and failed to stop Windows ConPTY.", {
            cause: error,
          }),
        );
      }
    }, 5_000);
    const finish = (error?: Error): void => {
      clearTimeout(timeout);
      unsubscribeData();
      unsubscribeExit();
      if (error) {
        reject(error);
        return;
      }
      resolve(output);
    };
    unsubscribeData = session.onData((data) => {
      output += data;
    });
    unsubscribeExit = session.onExit(() => {
      finish();
    });
  });
}
