import { spawn } from "node:child_process";

import { createTerminalError, type OperationId } from "@terminal/protocol";
import type { ResolvedShell } from "@terminal/pty-host";

export type CapturedProcessExitEvent = {
  exitCode: number | null;
  signal: string | null;
};

export type CapturedProcessObserver = {
  stdout(data: string): void;
  stderr(data: string): void;
  exit(event: CapturedProcessExitEvent): void;
};

export type CapturedProcessSpawnRequest = {
  operationId: OperationId;
  shell: ResolvedShell;
};

export type CapturedProcess = {
  kill(): void;
};

export type CapturedProcessHost = {
  spawn(
    request: CapturedProcessSpawnRequest,
    observer: CapturedProcessObserver,
  ): Promise<CapturedProcess>;
};

export class NodeCapturedProcessHost implements CapturedProcessHost {
  spawn(
    request: CapturedProcessSpawnRequest,
    observer: CapturedProcessObserver,
  ): Promise<CapturedProcess> {
    let spawned = false;
    const child = spawn(request.shell.executable, request.shell.args, {
      cwd: request.shell.cwd,
      env: request.shell.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data: string) => observer.stdout(data));
    child.stderr.on("data", (data: string) => observer.stderr(data));
    child.on("close", (exitCode, signal) => {
      if (!spawned) return;
      observer.exit({
        exitCode,
        signal: signal === null ? null : String(signal),
      });
    });

    return new Promise((resolve, reject) => {
      child.once("spawn", () => {
        spawned = true;
        resolve({
          kill() {
            child.kill();
          },
        });
      });
      child.once("error", (error) => {
        if (spawned) return;
        reject(
          createTerminalError(
            "process_spawn_failed",
            `Failed to start captured process with ${request.shell.executable}.`,
            {
              operationId: request.operationId,
              operation: "terminal.run",
              cause: error.message,
            },
          ),
        );
      });
    });
  }
}
