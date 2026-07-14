import { Buffer } from "node:buffer";

import type { ShellIntegrationState } from "@terminal/protocol";

import {
  MAX_SHELL_COMMAND_ID_LENGTH,
  MAX_SHELL_COMMAND_LINE_BYTES,
  MAX_SHELL_CWD_BYTES,
  MAX_SHELL_INTEGRATION_MARKER_BYTES,
  SHELL_INTEGRATION_PROTOCOL_VERSION,
} from "./constants.js";

export type ShellIntegrationEventName = "ready" | "prompt" | "command-start" | "command-finish";

export type ShellIntegrationMarker =
  | {
      event: "ready";
      capabilities: ShellIntegrationState["capabilities"];
    }
  | { event: "prompt"; cwd: string }
  | { event: "command-start"; commandId: string; commandLine?: string }
  | { event: "command-finish"; commandId: string; exitCode: number | null };

export type ParsedShellIntegrationMarker =
  | { type: "unhandled" }
  | { type: "ignored" }
  | { type: "invalid" }
  | { type: "event"; marker: ShellIntegrationMarker };

export function encodeShellIntegrationMarker(options: {
  nonce: string;
  event: ShellIntegrationEventName;
  commandId?: string;
  payload?: string;
}): string {
  const payload = encodePayload(options.payload ?? "");
  return [
    "PCT",
    String(SHELL_INTEGRATION_PROTOCOL_VERSION),
    options.nonce,
    options.event,
    options.commandId ?? "",
    payload,
  ].join(";");
}

export function formatShellIntegrationOsc(data: string): string {
  return `\u001b]633;${data}\u001b\\`;
}

export function encodePayload(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

export function parseShellIntegrationMarker(
  data: string,
  expectedNonce: string,
): ParsedShellIntegrationMarker {
  if (!data.startsWith("PCT;")) return { type: "unhandled" };
  const prefix = `PCT;${SHELL_INTEGRATION_PROTOCOL_VERSION};${expectedNonce};`;
  if (!data.startsWith(prefix)) return { type: "ignored" };
  if (Buffer.byteLength(data, "utf8") > MAX_SHELL_INTEGRATION_MARKER_BYTES) {
    return { type: "invalid" };
  }

  const fields = data.split(";");
  if (fields.length !== 6) return { type: "invalid" };
  const [, , , event, commandId, encodedPayload] = fields;
  if (!event || commandId === undefined || encodedPayload === undefined) {
    return { type: "invalid" };
  }
  if (!isBase64Url(encodedPayload)) return { type: "invalid" };

  switch (event) {
    case "ready": {
      if (commandId !== "") return { type: "invalid" };
      const payload = decodePayload(encodedPayload, 4 * 1024);
      if (payload === null) return { type: "invalid" };
      const capabilities = parseCapabilities(payload);
      return capabilities
        ? { type: "event", marker: { event, capabilities } }
        : { type: "invalid" };
    }
    case "prompt": {
      if (commandId !== "") return { type: "invalid" };
      const cwd = decodePayload(encodedPayload, MAX_SHELL_CWD_BYTES);
      return cwd ? { type: "event", marker: { event, cwd } } : { type: "invalid" };
    }
    case "command-start": {
      if (!isCommandId(commandId)) return { type: "invalid" };
      const commandLine = decodePayload(encodedPayload, MAX_SHELL_COMMAND_LINE_BYTES);
      if (commandLine === null) return { type: "invalid" };
      return {
        type: "event",
        marker: {
          event,
          commandId,
          ...(commandLine ? { commandLine } : {}),
        },
      };
    }
    case "command-finish": {
      if (!isCommandId(commandId)) return { type: "invalid" };
      const value = decodePayload(encodedPayload, 32);
      if (value === null || (value !== "" && !/^-?\d+$/.test(value))) {
        return { type: "invalid" };
      }
      const exitCode = value === "" ? null : Number(value);
      if (exitCode !== null && !Number.isSafeInteger(exitCode)) return { type: "invalid" };
      return { type: "event", marker: { event, commandId, exitCode } };
    }
    default:
      return { type: "invalid" };
  }
}

function decodePayload(value: string, maximumBytes: number): string | null {
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value || bytes.byteLength > maximumBytes) {
      return null;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function parseCapabilities(value: string): ShellIntegrationState["capabilities"] | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return null;
    const names = ["prompt", "commandStart", "commandFinish", "commandLine", "exitCode", "cwd"];
    if (
      Object.keys(parsed).length !== names.length ||
      names.some((name) => typeof parsed[name] !== "boolean")
    ) {
      return null;
    }
    return {
      prompt: parsed.prompt as boolean,
      commandStart: parsed.commandStart as boolean,
      commandFinish: parsed.commandFinish as boolean,
      commandLine: parsed.commandLine as boolean,
      exitCode: parsed.exitCode as boolean,
      cwd: parsed.cwd as boolean,
    };
  } catch {
    return null;
  }
}

function isCommandId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_SHELL_COMMAND_ID_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

function isBase64Url(value: string): boolean {
  return /^[A-Za-z0-9_-]*$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
