import type { RendererTerminalApi } from "@terminal/protocol";

declare global {
  interface Window {
    terminalApi: RendererTerminalApi;
  }
}
