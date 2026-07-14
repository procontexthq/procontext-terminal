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
  kill(): void | Promise<void>;
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
      detached: process.platform !== "win32",
      windowsHide: true,
      windowsVerbatimArguments: request.shell.windowsVerbatimArguments,
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
            return terminateProcessTree(child);
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

function terminateProcessTree(child: ReturnType<typeof spawn>): void | Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    return terminateWindowsProcessTree(child);
  }

  const pid = child.pid;
  if (pid !== undefined) {
    try {
      process.kill(-pid, "SIGTERM");
      return;
    } catch (error: unknown) {
      if (!isNoSuchProcessError(error)) throw error;
    }
  }

  if (child.exitCode === null && child.signalCode === null && !child.kill("SIGTERM")) {
    throw new Error("Captured process could not be terminated.");
  }
}

function terminateWindowsProcessTree(child: ReturnType<typeof spawn>): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const taskkill = spawn("taskkill.exe", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    taskkill.once("error", reject);
    taskkill.once("exit", (exitCode) => {
      if (exitCode === 0 || child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      reject(new Error(`taskkill exited with code ${String(exitCode)}.`));
    });
  });
}

function isNoSuchProcessError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH"
  );
}
