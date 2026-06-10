import { statSync } from "node:fs";
import { posix, win32 } from "node:path";
import process from "node:process";

export type DefaultTerminalCwdSource = "app-home" | "env-home" | "process-cwd" | "platform-root";

export type DefaultTerminalCwdResolution = {
  cwd: string;
  source: DefaultTerminalCwdSource;
};

type DefaultTerminalCwdOptions = {
  appHome: string;
  env?: NodeJS.ProcessEnv;
  isDirectory?: (path: string) => boolean;
  platform?: NodeJS.Platform;
  processCwd?: () => string;
};

export function resolveDefaultTerminalCwd(
  options: DefaultTerminalCwdOptions,
): DefaultTerminalCwdResolution {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const isDirectory = options.isDirectory ?? isExistingDirectory;
  const candidates: DefaultTerminalCwdResolution[] = [
    { cwd: options.appHome, source: "app-home" },
    { cwd: resolveEnvHome(platform, env) ?? "", source: "env-home" },
    { cwd: safeProcessCwd(options.processCwd ?? (() => process.cwd())), source: "process-cwd" },
  ];

  for (const candidate of candidates) {
    if (isUsableDirectory(candidate.cwd, platform, isDirectory)) {
      return candidate;
    }
  }

  return { cwd: platformRoot(platform, env), source: "platform-root" };
}

function resolveEnvHome(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string | null {
  if (platform !== "win32") {
    return getEnvValue(env, "HOME", platform) ?? null;
  }

  const userProfile = getEnvValue(env, "USERPROFILE", platform);
  if (userProfile) {
    return userProfile;
  }

  const homeDrive = getEnvValue(env, "HOMEDRIVE", platform);
  const homePath = getEnvValue(env, "HOMEPATH", platform);
  if (homeDrive && homePath) {
    return `${homeDrive}${homePath}`;
  }

  return getEnvValue(env, "HOME", platform) ?? null;
}

function safeProcessCwd(processCwd: () => string): string {
  try {
    return processCwd();
  } catch {
    return "";
  }
}

function isUsableDirectory(
  candidate: string,
  platform: NodeJS.Platform,
  isDirectory: (path: string) => boolean,
): boolean {
  return candidate.length > 0 && isAbsolutePath(candidate, platform) && isDirectory(candidate);
}

function isAbsolutePath(path: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" ? win32.isAbsolute(path) : posix.isAbsolute(path);
}

function isExistingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function platformRoot(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform !== "win32") {
    return "/";
  }

  const drive =
    getEnvValue(env, "SystemDrive", platform) ?? getEnvValue(env, "HOMEDRIVE", platform);
  if (!drive) {
    return "C:\\";
  }

  return drive.endsWith("\\") ? drive : `${drive}\\`;
}

function getEnvValue(
  env: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== "win32") {
    return env[name];
  }

  const entry = Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1];
}
