import { z } from "zod";

import { operationIdSchema, type OperationId, type SessionId } from "./ids.js";

export const DEFAULT_RUN_TIMEOUT_MS = 10_000;
export const MAX_RUN_TIMEOUT_MS = 120_000;
export const DEFAULT_CAPTURED_OUTPUT_BYTES = 1024 * 1024;
export const MAX_CAPTURED_OUTPUT_BYTES = 16 * 1024 * 1024;
export const TEMPORARY_PTY_OUTPUT_BYTES = 1024 * 1024;

export type TerminalPresentationMode = "headless" | "background" | "foreground";

export type RunTerminalRequest = {
  input: string;
  cwd?: string;
  env?: Record<string, string>;
  shell?: string;
  tty?: boolean;
  timeoutMs?: number;
  maxOutputBytesPerStream?: number;
  presentation?: TerminalPresentationMode;
};

export type RunningCapturedRun = {
  status: "running";
  operationId: OperationId;
  tty: false;
  version: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  elapsedMs: number;
};

export type CompletedCapturedRun = {
  status: "completed";
  operationId: OperationId;
  tty: false;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
};

export type RunningTerminalRun = {
  status: "running";
  operationId: OperationId;
  sessionId: SessionId;
  tty: true;
  observationVersion: number;
  elapsedMs: number;
};

export type CompletedTerminalRun = {
  status: "completed";
  operationId: OperationId;
  sessionId: SessionId;
  tty: true;
  exitCode: number | null;
  signal: string | null;
  output: string;
  truncated: boolean;
  observationVersion: number;
  durationMs: number;
};

export type RunTerminalResult =
  | RunningCapturedRun
  | CompletedCapturedRun
  | RunningTerminalRun
  | CompletedTerminalRun;

export type ObserveCapturedOperationRequest = {
  operationId: OperationId;
  afterVersion?: number;
  timeoutMs?: number;
};

export type CapturedOperationObservation = {
  operationId: OperationId;
  version: number;
  status: "running" | "completed" | "failed";
  stdout: string;
  stderr: string;
  truncated: boolean;
  exitCode?: number | null;
  signal?: string | null;
};

export type ObserveCapturedOperationResult =
  | { status: "changed"; observation: CapturedOperationObservation }
  | { status: "timeout"; operationId: OperationId; version: number };

export type CloseOperationRequest = { operationId: OperationId };

const timeoutSchema = z.number().int().min(1).max(MAX_RUN_TIMEOUT_MS);
export const terminalPresentationModeSchema = z.enum(["headless", "background", "foreground"]);

export const runTerminalRequestSchema = z
  .object({
    input: z.string().min(1),
    cwd: z.string().min(1).optional(),
    env: z.record(z.string(), z.string()).optional(),
    shell: z.string().min(1).optional(),
    tty: z.boolean().optional(),
    timeoutMs: timeoutSchema.optional(),
    maxOutputBytesPerStream: z.number().int().min(1).max(MAX_CAPTURED_OUTPUT_BYTES).optional(),
    presentation: terminalPresentationModeSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.tty === true && value.maxOutputBytesPerStream !== undefined) {
      context.addIssue({
        code: "custom",
        message: "maxOutputBytesPerStream is supported only when tty is false.",
        path: ["maxOutputBytesPerStream"],
      });
    }
    if (
      value.tty !== true &&
      (value.presentation === "background" || value.presentation === "foreground")
    ) {
      context.addIssue({
        code: "custom",
        message: "Captured one-shot runs do not support presented terminal views.",
        path: ["presentation"],
      });
    }
  });

export const observeCapturedOperationRequestSchema = z
  .object({
    operationId: operationIdSchema,
    afterVersion: z.number().int().nonnegative().optional(),
    timeoutMs: timeoutSchema.optional(),
  })
  .strict();

export const closeOperationRequestSchema = z.object({ operationId: operationIdSchema }).strict();

export function parseRunTerminalRequest(value: unknown): RunTerminalRequest {
  return runTerminalRequestSchema.parse(value);
}

export function parseObserveCapturedOperationRequest(
  value: unknown,
): ObserveCapturedOperationRequest {
  return observeCapturedOperationRequestSchema.parse(value);
}
