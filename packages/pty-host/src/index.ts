import { accessSync, chmodSync, constants, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, posix, win32 } from "node:path";
import process from "node:process";

import pty from "node-pty";

import { createTerminalError, type SessionId, type TerminalError } from "@terminal/protocol";

const require = createRequire(import.meta.url);

export type PtyExitEvent = {
  exitCode: number | null;
  signal: string | null;
};

export type PtySpawnRequest = {
  sessionId: SessionId;
  shell: ResolvedShell;
  cols: number;
  rows: number;
};

export type ShellResolutionRequest = {
  shell?: string;
  cwd?: string;
  env?: Record<string, string>;
};

export type CommandShellResolutionRequest = ShellResolutionRequest & {
  input: string;
};

type ExecutableAccessCheck = (executable: string, platform: NodeJS.Platform) => boolean;

export type ResolvedShell = {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  windowsVerbatimArguments?: boolean;
};

export type PtySession = {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(handler: (data: string) => void): () => void;
  onExit(handler: (event: PtyExitEvent) => void): () => void;
};

export type PtyHost = {
  spawn(request: PtySpawnRequest): Promise<PtySession>;
};

export function resolveShell(
  request: ShellResolutionRequest,
  options: {
    platform?: NodeJS.Platform;
    processEnv?: NodeJS.ProcessEnv;
    cwd?: string;
    canExecute?: ExecutableAccessCheck;
  } = {},
): ResolvedShell {
  const platform = options.platform ?? process.platform;
  const env = buildEnvironment(request.env, options.processEnv ?? process.env, platform);
  const canExecuteExecutable = options.canExecute ?? canExecute;
  const executable = resolveExecutable(
    request.shell ?? defaultShell(platform, env, canExecuteExecutable),
    platform,
    env,
    canExecuteExecutable,
  );
  return {
    executable,
    args: [],
    cwd: request.cwd ?? options.cwd ?? process.cwd(),
    env,
  };
}

export function resolveCommandShell(
  request: CommandShellResolutionRequest,
  options: {
    platform?: NodeJS.Platform;
    processEnv?: NodeJS.ProcessEnv;
    cwd?: string;
    canExecute?: ExecutableAccessCheck;
  } = {},
): ResolvedShell {
  const platform = options.platform ?? process.platform;
  const shell = resolveShell(request, options);
  return {
    ...shell,
    ...commandArguments(shell.executable, request.input, platform),
  };
}

export class NodePtyHost implements PtyHost {
  spawn(request: PtySpawnRequest): Promise<PtySession> {
    const shell = request.shell;
    try {
      validateShellExecutable(shell.executable, process.platform);
      ensureNodePtySpawnHelperExecutable();
      const args = shell.windowsVerbatimArguments ? shell.args.join(" ") : shell.args;
      const processHandle = pty.spawn(shell.executable, args, {
        name: "xterm-256color",
        cwd: shell.cwd,
        env: shell.env,
        cols: request.cols,
        rows: request.rows,
        ...(process.platform === "win32"
          ? {
              useConpty: true,
              useConptyDll: true,
            }
          : {}),
      });

      return Promise.resolve(new NodePtySession(processHandle));
    } catch (error: unknown) {
      return Promise.reject(mapSpawnError(error, request.sessionId, shell.executable));
    }
  }
}

class NodePtySession implements PtySession {
  private exited = false;
  private killRequested = false;

  constructor(private readonly processHandle: pty.IPty) {
    this.processHandle.onExit(() => {
      this.exited = true;
    });
  }

  write(data: string): void {
    this.processHandle.write(data);
  }

  resize(cols: number, rows: number): void {
    this.processHandle.resize(cols, rows);
  }

  kill(): void {
    if (this.exited || this.killRequested) return;
    this.killRequested = true;
    try {
      this.processHandle.kill();
    } catch (error: unknown) {
      this.killRequested = false;
      throw error;
    }
  }

  onData(handler: (data: string) => void): () => void {
    const disposable = this.processHandle.onData(handler);
    return () => disposable.dispose();
  }

  onExit(handler: (event: PtyExitEvent) => void): () => void {
    const disposable = this.processHandle.onExit((event) => {
      handler({
        exitCode: event.exitCode,
        signal: event.signal === undefined || event.signal === null ? null : String(event.signal),
      });
    });
    return () => disposable.dispose();
  }
}

function defaultShell(
  platform: NodeJS.Platform,
  env: Record<string, string>,
  canExecuteExecutable: ExecutableAccessCheck,
): string {
  if (platform === "win32") {
    const candidate = firstAvailableShell(
      ["pwsh.exe", "powershell.exe", env.ComSpec, "cmd.exe"],
      platform,
      env,
      canExecuteExecutable,
    );
    return candidate ?? env.ComSpec ?? "powershell.exe";
  }

  if (env.SHELL) {
    return env.SHELL;
  }

  return platform === "darwin" ? "/bin/zsh" : "/bin/sh";
}

function commandArguments(
  executable: string,
  input: string,
  platform: NodeJS.Platform,
): Pick<ResolvedShell, "args" | "windowsVerbatimArguments"> {
  if (platform !== "win32") {
    return { args: ["-c", input] };
  }

  const name = win32.basename(executable).toLowerCase();
  if (name === "cmd.exe" || name === "cmd") {
    return {
      args: ["/d", "/s", "/c", `"${input}"`],
      windowsVerbatimArguments: true,
    };
  }
  if (
    name === "pwsh.exe" ||
    name === "pwsh" ||
    name === "powershell.exe" ||
    name === "powershell"
  ) {
    return { args: ["-Command", input] };
  }
  return { args: ["-c", input] };
}

function buildEnvironment(
  overrides: Record<string, string> | undefined,
  baseEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }

  if (!overrides) {
    return env;
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (platform !== "win32") {
      env[key] = value;
      continue;
    }

    const existingKey = Object.keys(env).find(
      (candidate) => candidate.toLowerCase() === key.toLowerCase(),
    );
    env[existingKey ?? key] = value;
  }

  return env;
}

function ensureNodePtySpawnHelperExecutable(): void {
  if (process.platform !== "darwin") {
    return;
  }

  const packageJsonPath = require.resolve("node-pty/package.json");
  const packageRoot = dirname(packageJsonPath);
  const architecture = process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  const helperPath = join(packageRoot, "prebuilds", architecture, "spawn-helper");
  const mode = statSync(helperPath).mode;
  if ((mode & 0o111) === 0) {
    chmodSync(helperPath, mode | 0o755);
  }
}

function firstAvailableShell(
  candidates: Array<string | undefined>,
  platform: NodeJS.Platform,
  env: Record<string, string>,
  canExecuteExecutable: ExecutableAccessCheck,
): string | null {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = tryResolveExecutable(candidate, platform, env, canExecuteExecutable);
    if (resolved) return resolved;
  }
  return null;
}

function resolveExecutable(
  executable: string,
  platform: NodeJS.Platform,
  env: Record<string, string>,
  canExecuteExecutable: ExecutableAccessCheck,
): string {
  const resolved = tryResolveExecutable(executable, platform, env, canExecuteExecutable);
  if (resolved) return resolved;
  throw new Error(`Shell executable ${executable} was not found or is not executable.`);
}

function tryResolveExecutable(
  executable: string,
  platform: NodeJS.Platform,
  env: Record<string, string>,
  canExecuteExecutable: ExecutableAccessCheck,
): string | null {
  if (isPathLike(executable, platform)) {
    if (!isAbsolutePath(executable, platform)) {
      throw new Error(
        `Shell executable ${executable} must be an absolute path or a command name resolved through PATH.`,
      );
    }
    return canExecuteExecutable(executable, platform) ? executable : null;
  }

  const pathValue = getPathValue(env, platform);
  if (!pathValue) return null;

  const separator = platform === "win32" ? ";" : ":";
  for (const directory of pathValue.split(separator)) {
    if (!directory) continue;
    for (const candidate of executableCandidates(executable, platform, env)) {
      const resolved =
        platform === "win32" ? win32.join(directory, candidate) : posix.join(directory, candidate);
      if (canExecuteExecutable(resolved, platform)) {
        return resolved;
      }
    }
  }

  return null;
}

function executableCandidates(
  executable: string,
  platform: NodeJS.Platform,
  env: Record<string, string>,
): string[] {
  if (platform !== "win32" || win32.extname(executable)) {
    return [executable];
  }

  const pathExt = getEnvValue(env, "PATHEXT", platform) ?? ".COM;.EXE;.BAT;.CMD";
  return pathExt.split(";").map((extension) => `${executable}${extension.toLowerCase()}`);
}

function isPathLike(executable: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") {
    return win32.isAbsolute(executable) || executable.includes("/") || executable.includes("\\");
  }

  return posix.isAbsolute(executable) || executable.includes("/");
}

function isAbsolutePath(executable: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" ? win32.isAbsolute(executable) : posix.isAbsolute(executable);
}

function getPathValue(env: Record<string, string>, platform: NodeJS.Platform): string | undefined {
  return getEnvValue(env, "PATH", platform);
}

function getEnvValue(
  env: Record<string, string>,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== "win32") {
    return env[name];
  }

  const found = Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return found?.[1];
}

function validateShellExecutable(shell: string, platform: NodeJS.Platform): void {
  accessSync(shell, platform === "win32" ? constants.F_OK : constants.X_OK);
}

function canExecute(shell: string, platform: NodeJS.Platform): boolean {
  try {
    validateShellExecutable(shell, platform);
    return true;
  } catch {
    return false;
  }
}

function mapSpawnError(error: unknown, sessionId: SessionId, shell: string): TerminalError {
  return createTerminalError("pty_spawn_failed", `Failed to spawn PTY for shell ${shell}.`, {
    sessionId,
    operation: "spawn",
    cause: error instanceof Error ? error.message : String(error),
  });
}
