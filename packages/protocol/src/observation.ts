import { z } from "zod";

import { sessionIdSchema, type SessionId } from "./ids.js";
import {
  shellCommandStateSchema,
  shellIntegrationStateSchema,
  terminalDimensionsSchema,
  terminalLifecycleStateSchema,
  terminalPresentationSchema,
  terminalRecordingStatusSchema,
  type ShellCommandState,
  type ShellIntegrationState,
  type TerminalLifecycleState,
  type TerminalPresentation,
  type TerminalRecordingStatus,
} from "./sessions.js";

export type TerminalScreenRow = {
  row: number;
  text: string;
  wrapped: boolean;
};

export type TerminalObservation = {
  sessionId: SessionId;
  version: number;
  lifecycle: TerminalLifecycleState;
  dimensions: { cols: number; rows: number };
  viewport: {
    rows: TerminalScreenRow[];
    offsetFromBottom: number;
    atTop: boolean;
    atBottom: boolean;
    scrollbackRows: number;
    unseenRows: number;
  };
  cursor: { x: number; y: number; visible: boolean };
  alternateScreen: boolean;
  title: string | null;
  shellIntegration: ShellIntegrationState;
  command: ShellCommandState;
  presentation: TerminalPresentation;
  recording: TerminalRecordingStatus;
};

export type ObserveTerminalRequest = {
  sessionId: SessionId;
  afterVersion?: number;
  timeoutMs: number;
};

export type ObserveTerminalResult =
  | { status: "changed"; observation: TerminalObservation }
  | { status: "timeout"; sessionId: SessionId; version: number };

export const terminalScreenRowSchema = z.object({
  row: z.number().int().nonnegative(),
  text: z.string(),
  wrapped: z.boolean(),
});

export const terminalObservationSchema = z.object({
  sessionId: sessionIdSchema,
  version: z.number().int().nonnegative(),
  lifecycle: terminalLifecycleStateSchema,
  dimensions: terminalDimensionsSchema,
  viewport: z.object({
    rows: z.array(terminalScreenRowSchema),
    offsetFromBottom: z.number().int().nonnegative(),
    atTop: z.boolean(),
    atBottom: z.boolean(),
    scrollbackRows: z.number().int().nonnegative(),
    unseenRows: z.number().int().nonnegative(),
  }),
  cursor: z.object({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    visible: z.boolean(),
  }),
  alternateScreen: z.boolean(),
  title: z.string().nullable(),
  shellIntegration: shellIntegrationStateSchema,
  command: shellCommandStateSchema,
  presentation: terminalPresentationSchema,
  recording: terminalRecordingStatusSchema,
});

export const observeTerminalRequestSchema = z.object({
  sessionId: sessionIdSchema,
  afterVersion: z.number().int().nonnegative().optional(),
  timeoutMs: z.number().int().min(1).max(120_000),
});

export function parseTerminalObservation(value: unknown): TerminalObservation {
  return terminalObservationSchema.parse(value);
}

export function parseObserveTerminalRequest(value: unknown): ObserveTerminalRequest {
  return observeTerminalRequestSchema.parse(value);
}
