import { describe, it } from "vitest";

import { createOperationId } from "@terminal/protocol";

import { NodeCapturedProcessHost } from "../src/index";

describe("NodeCapturedProcessHost", () => {
  it("terminates the captured process and its foreground descendants", async () => {
    const host = new NodeCapturedProcessHost();
    let descendantPid: number | null = null;
    let output = "";
    let markReady: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    let markExited: () => void = () => undefined;
    const exited = new Promise<void>((resolve) => {
      markExited = resolve;
    });
    const processHandle = await host.spawn(
      {
        operationId: createOperationId("operation-process-tree"),
        shell: {
          executable: process.execPath,
          args: ["-e", parentProcessScript()],
          cwd: process.cwd(),
          env: processEnvironment(),
        },
      },
      {
        stdout(data) {
          output += data;
          const match = output.match(/DESCENDANT_PID:(\d+)/);
          if (!match?.[1]) return;
          descendantPid = Number(match[1]);
          markReady();
        },
        stderr() {},
        exit() {
          markExited();
        },
      },
    );

    try {
      await withTimeout(ready, 2_000, "Timed out waiting for captured descendant.");
      await processHandle.kill();

      await withTimeout(exited, 2_000, "Captured process tree did not terminate.");
    } finally {
      if (descendantPid !== null) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // The expected tree termination already removed the descendant.
        }
      }
    }
  });
});

function parentProcessScript(): string {
  return [
    'const { spawn } = require("node:child_process");',
    "const child = spawn(process.execPath,",
    '  ["-e", "setInterval(() => {}, 1_000)"],',
    '  { stdio: ["ignore", "inherit", "inherit"] },',
    ");",
    "process.stdout.write(`DESCENDANT_PID:${child.pid}\\n`);",
    "setInterval(() => {}, 1_000);",
  ].join("\n");
}

function processEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => {
      return typeof entry[1] === "string";
    }),
  );
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
