import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  terminalRecordingEventSchema,
  type SessionId,
  type TerminalRecordingEvent,
  type TerminalRecordingExport,
  type TerminalSessionSnapshot,
} from "@terminal/protocol";

type RecordingHeader = {
  type: "recording.header";
  schemaVersion: 1;
  sessionId: SessionId;
};

export type RecorderRedactor = (event: TerminalRecordingEvent) => TerminalRecordingEvent;

export type FileTerminalRecorderOptions = {
  directory: string;
  redactors?: RecorderRedactor[];
  now?: () => string;
};

export class FileTerminalRecorder {
  private readonly enabledSessions = new Set<SessionId>();
  private readonly writeQueues = new Map<SessionId, Promise<void>>();
  private redactors: RecorderRedactor[];
  private readonly now: () => string;

  constructor(private readonly options: FileTerminalRecorderOptions) {
    this.redactors = options.redactors ?? [];
    this.now = options.now ?? (() => new Date().toISOString());
  }

  updateRedactors(redactors: RecorderRedactor[]): void {
    this.redactors = redactors;
  }

  async start(session: TerminalSessionSnapshot): Promise<void> {
    this.enabledSessions.add(session.sessionId);
    try {
      await this.append(session.sessionId, {
        type: "session.created",
        sessionId: session.sessionId,
        at: this.now(),
        metadata: session,
      });
    } catch (error: unknown) {
      this.enabledSessions.delete(session.sessionId);
      throw error;
    }
  }

  async stop(sessionId: SessionId): Promise<void> {
    await this.waitForPendingWrites(sessionId);
    this.enabledSessions.delete(sessionId);
  }

  async record(event: TerminalRecordingEvent): Promise<void> {
    if (!this.enabledSessions.has(event.sessionId)) {
      return;
    }
    await this.append(event.sessionId, event);
  }

  async export(sessionId: SessionId): Promise<TerminalRecordingExport> {
    await this.waitForPendingWrites(sessionId);
    return {
      schemaVersion: 1,
      sessionId,
      exportedAt: this.now(),
      events: await this.readEvents(sessionId),
    };
  }

  private async append(sessionId: SessionId, event: TerminalRecordingEvent): Promise<void> {
    const redactedEvent = terminalRecordingEventSchema.parse(this.redact(event));
    await this.enqueueWrite(sessionId, async () => {
      await mkdir(this.options.directory, { recursive: true });
      await this.ensureHeader(sessionId);
      await appendFile(
        recordingPath(this.options.directory, sessionId),
        `${JSON.stringify(redactedEvent)}\n`,
        "utf8",
      );
    });
  }

  private async enqueueWrite(sessionId: SessionId, write: () => Promise<void>): Promise<void> {
    const previous = this.writeQueues.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(write);
    this.writeQueues.set(sessionId, next);
    try {
      await next;
    } finally {
      if (this.writeQueues.get(sessionId) === next) {
        this.writeQueues.delete(sessionId);
      }
    }
  }

  private async waitForPendingWrites(sessionId: SessionId): Promise<void> {
    await this.writeQueues.get(sessionId);
  }

  private async readEvents(sessionId: SessionId): Promise<TerminalRecordingEvent[]> {
    try {
      const raw = await readFile(recordingPath(this.options.directory, sessionId), "utf8");
      const trimmed = raw.trim();
      if (!trimmed) {
        return [];
      }
      if (trimmed.startsWith("[")) {
        const parsed = JSON.parse(trimmed) as unknown;
        if (!Array.isArray(parsed)) {
          throw new Error("Legacy recording data must be a JSON array.");
        }
        return parsed.map((event) => parseRecordingEvent(event, sessionId));
      }
      return parseJsonlRecording(raw, sessionId);
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  private redact(event: TerminalRecordingEvent): TerminalRecordingEvent {
    return this.redactors.reduce((nextEvent, redactor) => redactor(nextEvent), event);
  }

  private async ensureHeader(sessionId: SessionId): Promise<void> {
    try {
      await writeFile(
        recordingPath(this.options.directory, sessionId),
        `${JSON.stringify(createRecordingHeader(sessionId))}\n`,
        { encoding: "utf8", flag: "wx" },
      );
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "EEXIST") {
        await this.verifyExistingHeader(sessionId);
        return;
      }
      throw error;
    }
  }

  private async verifyExistingHeader(sessionId: SessionId): Promise<void> {
    const raw = await readFile(recordingPath(this.options.directory, sessionId), "utf8");
    const [headerLine] = raw.split("\n").filter((line) => line.trim().length > 0);
    if (!headerLine) {
      throw new Error(`Recording ${sessionId} has no header.`);
    }
    const header = JSON.parse(headerLine) as unknown;
    if (!isRecordingHeader(header) || header.sessionId !== sessionId) {
      throw new Error(`Recording ${sessionId} has an invalid header.`);
    }
  }
}

export function createPatternRedactor(patterns: string[]): RecorderRedactor {
  const expressions = patterns.map((pattern) => new RegExp(pattern, "gu"));
  return (event) => {
    if (!("data" in event)) {
      return event;
    }
    let data = event.data;
    for (const expression of expressions) {
      data = data.replace(expression, "[redacted]");
    }
    return { ...event, data };
  };
}

function createRecordingHeader(sessionId: SessionId): RecordingHeader {
  return { type: "recording.header", schemaVersion: 1, sessionId };
}

function parseJsonlRecording(raw: string, sessionId: SessionId): TerminalRecordingEvent[] {
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const [headerLine, ...eventLines] = lines;
  if (!headerLine) {
    return [];
  }
  const header = JSON.parse(headerLine) as unknown;
  if (!isRecordingHeader(header) || header.sessionId !== sessionId) {
    throw new Error(`Recording ${sessionId} has an invalid header.`);
  }
  return eventLines.map((line) => parseRecordingEvent(JSON.parse(line) as unknown, sessionId));
}

function parseRecordingEvent(value: unknown, sessionId: SessionId): TerminalRecordingEvent {
  const event = terminalRecordingEventSchema.parse(value);
  if (event.sessionId !== sessionId) {
    throw new Error(`Recording event belongs to ${event.sessionId}, expected ${sessionId}.`);
  }
  return event;
}

function isRecordingHeader(value: unknown): value is RecordingHeader {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "recording.header" &&
    "schemaVersion" in value &&
    value.schemaVersion === 1 &&
    "sessionId" in value &&
    typeof value.sessionId === "string"
  );
}

function recordingPath(directory: string, sessionId: SessionId): string {
  return join(directory, `${encodeURIComponent(sessionId)}.json`);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
