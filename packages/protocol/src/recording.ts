import { z } from "zod";

import { sessionIdSchema, type SessionId } from "./ids.js";
import { inputOriginSchema, type InputOrigin } from "./sessions.js";

export type TerminalRecordingEvent =
  | {
      type: "session.created";
      sessionId: SessionId;
      at: string;
      metadata: Record<string, unknown>;
    }
  | { type: "pty.output"; sessionId: SessionId; at: string; data: string }
  | {
      type: "terminal.input";
      sessionId: SessionId;
      at: string;
      origin: InputOrigin;
      data: string;
    }
  | {
      type: "terminal.resize";
      sessionId: SessionId;
      at: string;
      cols: number;
      rows: number;
    }
  | {
      type: "session.exited";
      sessionId: SessionId;
      at: string;
      exitCode: number | null;
      signal: string | null;
    };

export type RecordingControlRequest = { sessionId: SessionId };

export type TerminalRecordingExport = {
  schemaVersion: 1;
  sessionId: SessionId;
  exportedAt: string;
  events: TerminalRecordingEvent[];
};

const common = { sessionId: sessionIdSchema, at: z.string().min(1) };

export const terminalRecordingEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session.created"),
    ...common,
    metadata: z.record(z.string(), z.unknown()),
  }),
  z.object({ type: z.literal("pty.output"), ...common, data: z.string() }),
  z.object({
    type: z.literal("terminal.input"),
    ...common,
    origin: inputOriginSchema,
    data: z.string(),
  }),
  z.object({
    type: z.literal("terminal.resize"),
    ...common,
    cols: z.number().int().min(1).max(1_000),
    rows: z.number().int().min(1).max(1_000),
  }),
  z.object({
    type: z.literal("session.exited"),
    ...common,
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
  }),
]);

export const recordingControlRequestSchema = z.object({ sessionId: sessionIdSchema });

export const terminalRecordingExportSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: sessionIdSchema,
  exportedAt: z.string().min(1),
  events: z.array(terminalRecordingEventSchema),
});

export function parseTerminalRecordingExport(value: unknown): TerminalRecordingExport {
  return terminalRecordingExportSchema.parse(value);
}
