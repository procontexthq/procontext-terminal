import type { ShellCommandState, ShellIntegrationState } from "@terminal/protocol";

import {
  fullShellIntegrationCapabilities,
  unavailableShellIntegrationCapabilities,
} from "./constants.js";
import { parseShellIntegrationMarker, type ShellIntegrationMarker } from "./markers.js";

export type ShellIntegrationSnapshot = {
  cwd: string;
  integration: ShellIntegrationState;
  command: ShellCommandState;
};

export class ShellIntegrationTracker {
  private cwd: string;
  private integration: ShellIntegrationState;
  private command: ShellCommandState = { state: "unknown" };
  private readonly now: () => Date;

  constructor(
    private readonly options: {
      nonce?: string;
      cwd: string;
      now?: () => Date;
    },
  ) {
    this.cwd = options.cwd;
    this.now = options.now ?? (() => new Date());
    this.integration = options.nonce
      ? {
          status: "initializing",
          capabilities: { ...unavailableShellIntegrationCapabilities },
        }
      : {
          status: "unavailable",
          capabilities: { ...unavailableShellIntegrationCapabilities },
        };
  }

  get snapshot(): ShellIntegrationSnapshot {
    return {
      cwd: this.cwd,
      integration: this.integration,
      command: this.command,
    };
  }

  acceptOsc(data: string): { handled: boolean; changed: boolean } {
    if (!this.options.nonce) return { handled: data.startsWith("PCT;"), changed: false };
    const parsed = parseShellIntegrationMarker(data, this.options.nonce);
    switch (parsed.type) {
      case "unhandled":
        return { handled: false, changed: false };
      case "ignored":
        return { handled: true, changed: false };
      case "invalid":
        return { handled: true, changed: this.degrade() };
      case "event":
        return { handled: true, changed: this.apply(parsed.marker) };
    }
  }

  markInitializationTimedOut(): boolean {
    if (this.integration.status !== "initializing") return false;
    return this.degrade();
  }

  markShellExited(): boolean {
    if (this.command.state !== "running") return false;
    this.command = { state: "unknown" };
    return true;
  }

  private apply(marker: ShellIntegrationMarker): boolean {
    const before = JSON.stringify(this.snapshot);
    switch (marker.event) {
      case "ready": {
        const available = sameCapabilities(marker.capabilities, fullShellIntegrationCapabilities);
        this.integration = {
          status: available ? "available" : "degraded",
          capabilities: marker.capabilities,
        };
        if (!available) this.command = { state: "unknown" };
        break;
      }
      case "prompt": {
        if (
          this.integration.status === "unavailable" ||
          this.integration.status === "initializing"
        ) {
          break;
        }
        this.now();
        if (this.integration.capabilities.cwd) this.cwd = marker.cwd;
        if (this.integration.status !== "available") break;
        if (this.command.state === "running") return this.degrade();
        this.command =
          this.command.state === "idle" && this.command.lastCommand
            ? { state: "idle", lastCommand: this.command.lastCommand }
            : { state: "idle" };
        break;
      }
      case "command-start": {
        if (this.integration.status !== "available") break;
        if (this.command.state === "running") return this.degrade();
        const startedAt = this.now().toISOString();
        this.command = {
          state: "running",
          commandId: marker.commandId,
          ...(marker.commandLine ? { commandLine: marker.commandLine } : {}),
          startedAt,
        };
        break;
      }
      case "command-finish": {
        if (this.integration.status !== "available") break;
        if (this.command.state !== "running" || this.command.commandId !== marker.commandId) {
          return this.degrade();
        }
        const running = this.command;
        this.command = {
          state: "idle",
          lastCommand: {
            commandId: marker.commandId,
            ...(running.commandLine ? { commandLine: running.commandLine } : {}),
            exitCode: marker.exitCode,
            ...(running.startedAt ? { startedAt: running.startedAt } : {}),
            finishedAt: this.now().toISOString(),
          },
        };
        break;
      }
    }
    return before !== JSON.stringify(this.snapshot);
  }

  private degrade(): boolean {
    const before = JSON.stringify(this.snapshot);
    this.integration = {
      status: "degraded",
      capabilities: { ...unavailableShellIntegrationCapabilities },
    };
    this.command = { state: "unknown" };
    return before !== JSON.stringify(this.snapshot);
  }
}

function sameCapabilities(
  left: ShellIntegrationState["capabilities"],
  right: ShellIntegrationState["capabilities"],
): boolean {
  return (
    left.prompt === right.prompt &&
    left.commandStart === right.commandStart &&
    left.commandFinish === right.commandFinish &&
    left.commandLine === right.commandLine &&
    left.exitCode === right.exitCode &&
    left.cwd === right.cwd
  );
}
