import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, posix } from "node:path";

import type { ShellIntegrationState } from "@terminal/protocol";

import { unavailableShellIntegrationCapabilities } from "./constants.js";
import { bashBootstrap, fishBootstrap, powershellBootstrap, zshBootstrap } from "./scripts.js";

export type SupportedShell = "bash" | "zsh" | "fish" | "powershell";

export type ShellLaunchConfiguration = {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  windowsVerbatimArguments?: boolean;
};

export type PreparedShellIntegrationLaunch = {
  launch: ShellLaunchConfiguration;
  shell: SupportedShell | null;
  integration: ShellIntegrationState;
  nonce?: string;
  temporaryPath?: string;
  cleanup(): void;
};

export function detectSupportedShell(executable: string): SupportedShell | null {
  const name = basename(executable.replaceAll("\\", "/")).toLowerCase();
  switch (name) {
    case "bash":
    case "bash.exe":
      return "bash";
    case "zsh":
    case "zsh.exe":
      return "zsh";
    case "fish":
    case "fish.exe":
      return "fish";
    case "pwsh":
    case "pwsh.exe":
    case "powershell":
    case "powershell.exe":
      return "powershell";
    default:
      return null;
  }
}

export function createShellIntegrationNonce(
  bytes: () => Uint8Array = () => randomBytes(16),
): string {
  const value = bytes();
  if (value.byteLength !== 16) {
    throw new Error("Shell integration nonce source must provide exactly 16 bytes.");
  }
  return Buffer.from(value).toString("base64url");
}

export function prepareShellIntegrationLaunch(
  launch: ShellLaunchConfiguration,
  options: {
    nonce?: string;
    temporaryRoot?: string;
  } = {},
): PreparedShellIntegrationLaunch {
  const shell = detectSupportedShell(launch.executable);
  if (!shell) {
    return {
      launch: cloneLaunch(launch),
      shell: null,
      integration: unavailableIntegration(),
      cleanup() {},
    };
  }

  const nonce = options.nonce ?? createShellIntegrationNonce();
  const env: Record<string, string> = { ...launch.env };
  let temporaryPath: string | undefined;
  let args = [...launch.args];

  if (shell === "bash") {
    temporaryPath = privateTemporaryDirectory(options.temporaryRoot);
    const rcfile = join(temporaryPath, "bashrc");
    writeFileSync(rcfile, bashBootstrap(posix.join(env.HOME ?? "", ".bashrc"), nonce), {
      encoding: "utf8",
      mode: 0o600,
    });
    args = ["--rcfile", rcfile, ...args];
  } else if (shell === "zsh") {
    temporaryPath = privateTemporaryDirectory(options.temporaryRoot);
    const originalZdotdir = env.ZDOTDIR ?? env.HOME ?? null;
    const startupRoot = originalZdotdir ?? "";
    writeFileSync(
      join(temporaryPath, ".zshenv"),
      `${forwardStartupFile(posix.join(startupRoot, ".zshenv"))}export ZDOTDIR=${shellQuote(
        temporaryPath,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    writeFileSync(
      join(temporaryPath, ".zprofile"),
      `${forwardStartupFile(posix.join(startupRoot, ".zprofile"))}export ZDOTDIR=${shellQuote(
        temporaryPath,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    writeFileSync(
      join(temporaryPath, ".zshrc"),
      zshBootstrap(posix.join(startupRoot, ".zshrc"), originalZdotdir, nonce),
      { encoding: "utf8", mode: 0o600 },
    );
    env.ZDOTDIR = temporaryPath;
  } else if (shell === "fish") {
    temporaryPath = privateTemporaryDirectory(options.temporaryRoot);
    const initFile = join(temporaryPath, "fish-init.fish");
    writeFileSync(initFile, fishBootstrap(nonce), { encoding: "utf8", mode: 0o600 });
    args = [...args, "--init-command", `source ${shellQuote(initFile)}`];
  } else {
    args = [...args, "-NoExit", "-Command", powershellBootstrap(nonce)];
  }

  return {
    launch: {
      ...cloneLaunch(launch),
      args,
      env,
    },
    shell,
    integration: {
      status: "initializing",
      capabilities: { ...unavailableShellIntegrationCapabilities },
    },
    nonce,
    ...(temporaryPath ? { temporaryPath } : {}),
    cleanup() {
      if (temporaryPath) rmSync(temporaryPath, { recursive: true, force: true });
    },
  };
}

function privateTemporaryDirectory(root = tmpdir()): string {
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, "procontext-shell-"), { encoding: "utf8" });
}

function forwardStartupFile(path: string): string {
  const quoted = shellQuote(path);
  return `if [[ -r ${quoted} ]]; then\n  source ${quoted}\nfi\n`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function cloneLaunch(launch: ShellLaunchConfiguration): ShellLaunchConfiguration {
  return {
    ...launch,
    args: [...launch.args],
    env: { ...launch.env },
  };
}

function unavailableIntegration(): ShellIntegrationState {
  return {
    status: "unavailable",
    capabilities: { ...unavailableShellIntegrationCapabilities },
  };
}
