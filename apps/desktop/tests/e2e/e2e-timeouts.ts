export function terminalUiTimeoutMs(platform: NodeJS.Platform): number {
  return platform === "win32" ? 30000 : 10000;
}
