import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createSessionId } from "@terminal/protocol";

import { NodePtyHost, resolveShell, type PtyExitEvent, type PtySession } from "../src/index";

const OSC_MARKER = "\u001b]633;PCT_TRANSPORT\u001b\\";
const ALTERNATE_SCREEN_OUTPUT = "\u001b[?1049hPCT_ALT_BODY\u001b[?1049l";

describe.skipIf(process.platform !== "win32")("Windows ConPTY transport", () => {
  it("preserves interactive input and terminal control sequences for installed PowerShell variants", async () => {
    const shells = installedPowerShells();
    expect(shells.length).toBeGreaterThan(0);

    for (const { name, shell } of shells) {
      shell.args = ["-NoLogo", "-NoProfile"];
      const session = await new NodePtyHost().spawn({
        sessionId: createSessionId(`windows-conpty-${name}`),
        shell,
        cols: 80,
        rows: 24,
      });
      const { command, outputMarker } = interactivePowerShellCommand();
      const result = await writeAndCollectUntilExit(session, `${command}\r`);

      expect(result.exit, `${name} exit`).toMatchObject({ exitCode: 0, signal: null });
      expect(result.output, `${name} executed output`).toContain(outputMarker);
      expect(result.output, `${name} OSC transport`).toContain(OSC_MARKER);
      expect(result.output, `${name} alternate-screen transport`).toContain(
        ALTERNATE_SCREEN_OUTPUT,
      );
    }
  }, 90_000);
});

function installedPowerShells(): Array<{
  name: string;
  shell: ReturnType<typeof resolveShell>;
}> {
  return ["powershell.exe", "pwsh.exe"].flatMap((name) => {
    try {
      return [{ name, shell: resolveShell({ shell: name, cwd: process.cwd() }) }];
    } catch {
      return [];
    }
  });
}

function interactivePowerShellCommand(): { command: string; outputMarker: string } {
  const token = randomUUID().replaceAll("-", "");
  const markerParts = ["PCT", "INTERACTIVE", token.slice(0, 16), token.slice(16), "OK"];
  const outputMarker = markerParts.join("_");
  const command = [
    "$e=[char]27",
    `$parts=@('${markerParts.join("','")}')`,
    "Write-Output ($parts -join '_')",
    "[Console]::Write($e+']633;PCT_TRANSPORT'+$e+'\\')",
    "[Console]::Write($e+'[?1049h'+'PCT_ALT_BODY'+$e+'[?1049l')",
    "exit 0",
  ].join("; ");
  if (command.includes(outputMarker)) {
    throw new Error("Interactive-output marker must not appear in the echoed command source.");
  }
  return { command, outputMarker };
}

function writeAndCollectUntilExit(
  session: PtySession,
  input: string,
): Promise<{ output: string; exit: PtyExitEvent }> {
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    let unsubscribeData = (): void => {};
    let unsubscribeExit = (): void => {};
    const finish = (result: { output: string; exit: PtyExitEvent } | Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      unsubscribeData();
      unsubscribeExit();
      if (result instanceof Error) {
        reject(result);
      } else {
        resolve(result);
      }
    };
    const timeout = setTimeout(() => {
      try {
        session.kill();
        finish(new Error("Timed out waiting for interactive Windows ConPTY output."));
      } catch (error: unknown) {
        finish(
          new Error("Timed out waiting for Windows ConPTY and failed to stop it.", {
            cause: error,
          }),
        );
      }
    }, 30_000);

    unsubscribeData = session.onData((data) => {
      output += data;
    });
    unsubscribeExit = session.onExit((exit) => {
      finish({ output, exit });
    });

    try {
      session.write(input);
    } catch (error: unknown) {
      finish(new Error("Failed to write interactive Windows ConPTY input.", { cause: error }));
    }
  });
}
