import type { ShellIntegrationState } from "@terminal/protocol";

export const SHELL_INTEGRATION_OSC = 633;
export const SHELL_INTEGRATION_PROTOCOL_VERSION = 1;
export const SHELL_INTEGRATION_INITIALIZATION_TIMEOUT_MS = 10_000;
export const MAX_SHELL_INTEGRATION_MARKER_BYTES = 64 * 1024;
export const MAX_SHELL_COMMAND_LINE_BYTES = 32 * 1024;
export const MAX_SHELL_CWD_BYTES = 4 * 1024;
export const MAX_SHELL_COMMAND_ID_LENGTH = 64;

export const unavailableShellIntegrationCapabilities: ShellIntegrationState["capabilities"] = {
  prompt: false,
  commandStart: false,
  commandFinish: false,
  commandLine: false,
  exitCode: false,
  cwd: false,
};

export const fullShellIntegrationCapabilities: ShellIntegrationState["capabilities"] = {
  prompt: true,
  commandStart: true,
  commandFinish: true,
  commandLine: true,
  exitCode: true,
  cwd: true,
};
