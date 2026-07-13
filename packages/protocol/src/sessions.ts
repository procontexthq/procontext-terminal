import { z } from "zod";

import { terminalErrorSchema, type TerminalError } from "./errors.js";
import { sessionIdSchema, type SessionId } from "./ids.js";
import { terminalPresentationModeSchema, type TerminalPresentationMode } from "./operations.js";

export type InputOrigin = "human" | "agent" | "system";
export type TerminalLifecycleState = "creating" | "running" | "exiting" | "exited" | "failed";
export type TerminalPresentationState =
  | "headless"
  | "opening"
  | "background"
  | "foreground"
  | "unavailable";

export type TerminalPresentation = {
  state: TerminalPresentationState;
  windowVisible: boolean;
  windowFocused: boolean;
};

export type ShellIntegrationState = {
  status: "initializing" | "available" | "degraded" | "unavailable";
  capabilities: {
    prompt: boolean;
    commandStart: boolean;
    commandFinish: boolean;
    commandLine: boolean;
    exitCode: boolean;
    cwd: boolean;
  };
};

export type CompletedShellCommand = {
  commandId: string;
  commandLine?: string;
  exitCode: number | null;
  startedAt?: string;
  finishedAt: string;
};

export type ShellCommandState =
  | { state: "idle"; lastCommand?: CompletedShellCommand }
  | { state: "running"; commandId: string; commandLine?: string; startedAt?: string }
  | { state: "unknown" };

export type TerminalRecordingStatus =
  | { state: "inactive" }
  | { state: "active" }
  | { state: "failed"; error: TerminalError };

export type CreateTerminalRequest = {
  cwd?: string;
  shell?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  presentation?: TerminalPresentationMode;
};

export type RendererCreateTerminalRequest = CreateTerminalRequest & {
  createdBy?: InputOrigin;
};

export type GetTerminalRequest = { sessionId: SessionId };
export type AttachTerminalRequest = {
  sessionId: SessionId;
  presentation?: TerminalPresentationMode | "unchanged";
};
export type SetTerminalPresentationRequest = {
  sessionId: SessionId;
  presentation: TerminalPresentationMode;
};

export type TerminalInputRequest = {
  sessionId: SessionId;
  input: string;
};

export type RendererTerminalInputRequest = TerminalInputRequest & {
  origin?: InputOrigin;
};

export type TerminalInputResult = {
  accepted: true;
  observationVersion: number;
};

export type ResizeTerminalRequest = {
  sessionId: SessionId;
  cols: number;
  rows: number;
};

export type ResizeTerminalResult = {
  observationVersion: number;
};

export type TerminalScrollAction =
  | { type: "lines"; delta: number }
  | { type: "page"; direction: "up" | "down" }
  | { type: "edge"; edge: "top" | "bottom" };

export type ScrollTerminalRequest = {
  sessionId: SessionId;
  scroll: TerminalScrollAction;
};

export type ScrollTerminalResult = {
  status: "changed" | "unchanged";
  observationVersion: number;
};

export type CloseTerminalRequest = { sessionId: SessionId };
export type CloseTerminalResult =
  | { status: "closed"; exitCode: number | null; signal: string | null }
  | { status: "termination_pending" };

export type TerminalSessionSummary = {
  sessionId: SessionId;
  lifecycle: TerminalLifecycleState;
  shell: string;
  cwd: string;
  dimensions: { cols: number; rows: number };
  title: string | null;
  createdBy: InputOrigin;
  createdAt: string;
  updatedAt: string;
  exitedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  error?: TerminalError;
  observationVersion: number;
  presentation: TerminalPresentation;
  shellIntegration: ShellIntegrationState;
  command: ShellCommandState;
  recording: TerminalRecordingStatus;
};

export const inputOriginSchema = z.enum(["human", "agent", "system"]);
export const terminalLifecycleStateSchema = z.enum([
  "creating",
  "running",
  "exiting",
  "exited",
  "failed",
]);

export const terminalDimensionsSchema = z.object({
  cols: z.number().int().min(1).max(1_000),
  rows: z.number().int().min(1).max(1_000),
});

export const terminalPresentationSchema = z.object({
  state: z.enum(["headless", "opening", "background", "foreground", "unavailable"]),
  windowVisible: z.boolean(),
  windowFocused: z.boolean(),
});

const shellIntegrationCapabilitiesSchema = z.object({
  prompt: z.boolean(),
  commandStart: z.boolean(),
  commandFinish: z.boolean(),
  commandLine: z.boolean(),
  exitCode: z.boolean(),
  cwd: z.boolean(),
});

export const shellIntegrationStateSchema = z.object({
  status: z.enum(["initializing", "available", "degraded", "unavailable"]),
  capabilities: shellIntegrationCapabilitiesSchema,
});

const completedShellCommandSchema = z.object({
  commandId: z.string().min(1),
  commandLine: z.string().optional(),
  exitCode: z.number().int().nullable(),
  startedAt: z.string().min(1).optional(),
  finishedAt: z.string().min(1),
});

export const shellCommandStateSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("idle"), lastCommand: completedShellCommandSchema.optional() }),
  z.object({
    state: z.literal("running"),
    commandId: z.string().min(1),
    commandLine: z.string().optional(),
    startedAt: z.string().min(1).optional(),
  }),
  z.object({ state: z.literal("unknown") }),
]);

export const terminalRecordingStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("inactive") }),
  z.object({ state: z.literal("active") }),
  z.object({ state: z.literal("failed"), error: terminalErrorSchema }),
]);

export const createTerminalRequestSchema = z.object({
  cwd: z.string().min(1).optional(),
  shell: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cols: terminalDimensionsSchema.shape.cols.optional(),
  rows: terminalDimensionsSchema.shape.rows.optional(),
  presentation: terminalPresentationModeSchema.optional(),
});

export const rendererCreateTerminalRequestSchema = createTerminalRequestSchema.extend({
  createdBy: inputOriginSchema.optional(),
});

export const getTerminalRequestSchema = z.object({ sessionId: sessionIdSchema });
export const attachTerminalRequestSchema = z.object({
  sessionId: sessionIdSchema,
  presentation: z.union([terminalPresentationModeSchema, z.literal("unchanged")]).optional(),
});
export const setTerminalPresentationRequestSchema = z.object({
  sessionId: sessionIdSchema,
  presentation: terminalPresentationModeSchema,
});
export const closeTerminalRequestSchema = getTerminalRequestSchema;

export const terminalInputRequestSchema = z.object({
  sessionId: sessionIdSchema,
  input: z.string().min(1),
});

export const rendererTerminalInputRequestSchema = terminalInputRequestSchema.extend({
  origin: inputOriginSchema.optional(),
});

export const resizeTerminalRequestSchema = z.object({
  sessionId: sessionIdSchema,
  ...terminalDimensionsSchema.shape,
});

export const terminalScrollActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("lines"),
    delta: z
      .number()
      .int()
      .refine((value) => value !== 0),
  }),
  z.object({ type: z.literal("page"), direction: z.enum(["up", "down"]) }),
  z.object({ type: z.literal("edge"), edge: z.enum(["top", "bottom"]) }),
]);

export const scrollTerminalRequestSchema = z.object({
  sessionId: sessionIdSchema,
  scroll: terminalScrollActionSchema,
});

export const terminalSessionSummarySchema = z.object({
  sessionId: sessionIdSchema,
  lifecycle: terminalLifecycleStateSchema,
  shell: z.string().min(1),
  cwd: z.string().min(1),
  dimensions: terminalDimensionsSchema,
  title: z.string().nullable(),
  createdBy: inputOriginSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  exitedAt: z.string().min(1).optional(),
  exitCode: z.number().int().nullable().optional(),
  signal: z.string().nullable().optional(),
  error: terminalErrorSchema.optional(),
  observationVersion: z.number().int().nonnegative(),
  presentation: terminalPresentationSchema,
  shellIntegration: shellIntegrationStateSchema,
  command: shellCommandStateSchema,
  recording: terminalRecordingStatusSchema,
});

export function parseCreateTerminalRequest(value: unknown): CreateTerminalRequest {
  return createTerminalRequestSchema.parse(value);
}

export function parseTerminalInputRequest(value: unknown): TerminalInputRequest {
  return terminalInputRequestSchema.parse(value);
}

export function parseResizeTerminalRequest(value: unknown): ResizeTerminalRequest {
  return resizeTerminalRequestSchema.parse(value);
}

export function parseScrollTerminalRequest(value: unknown): ScrollTerminalRequest {
  return scrollTerminalRequestSchema.parse(value);
}
