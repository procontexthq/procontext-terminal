import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  SessionId,
  TerminalRecordingEvent,
  TerminalRecordingExport,
  TerminalSessionSnapshot,
} from "@terminal/protocol";

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
    await this.append(session.sessionId, {
      type: "session.created",
      sessionId: session.sessionId,
      at: this.now(),
      metadata: session,
    });
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
    const redactedEvent = this.redact(event);
    await this.enqueueWrite(sessionId, async () => {
      await mkdir(this.options.directory, { recursive: true });
      const events = await this.readEvents(sessionId);
      events.push(redactedEvent);
      await writeFile(
        recordingPath(this.options.directory, sessionId),
        `${JSON.stringify(events)}\n`,
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
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as TerminalRecordingEvent[]) : [];
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

function recordingPath(directory: string, sessionId: SessionId): string {
  return join(directory, `${encodeURIComponent(sessionId)}.json`);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
