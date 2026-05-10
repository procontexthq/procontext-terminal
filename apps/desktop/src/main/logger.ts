import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogRecord = {
  timestamp: string;
  level: LogLevel;
  component: string;
  event: string;
  [key: string]: unknown;
};

export type LogSink = {
  write(line: string): void;
};

export type AppLogger = {
  debug(component: string, event: string, context?: Record<string, unknown>): void;
  info(component: string, event: string, context?: Record<string, unknown>): void;
  warn(component: string, event: string, context?: Record<string, unknown>): void;
  error(component: string, event: string, context?: Record<string, unknown>): void;
};

export type CreateAppLoggerOptions = {
  isDevelopment: boolean;
  logDirectory?: string;
  stderr?: Pick<NodeJS.WriteStream, "write">;
  level?: LogLevel;
  sink?: LogSink;
  fallbackSink?: LogSink;
  now?: () => string;
  maxStringLength?: number;
  maxFileBytes?: number;
  maxFiles?: number;
};

const levelPriority: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};
const sensitiveKeyPattern = /(password|secret|token|key|auth|credential|cookie|env)/i;
const defaultMaxStringLength = 2000;
const defaultMaxFileBytes = 5 * 1024 * 1024;
const defaultMaxFiles = 3;

export function createAppLogger(options: CreateAppLoggerOptions): AppLogger {
  const now = options.now ?? (() => new Date().toISOString());
  const level = options.level ?? defaultLogLevel(options.isDevelopment);
  const maxStringLength = options.maxStringLength ?? defaultMaxStringLength;
  const sink = options.sink ?? createDefaultSink(options);
  const fallbackSink = options.fallbackSink ?? new StderrLogSink(options.stderr);

  function log(levelName: LogLevel, component: string, event: string, context = {}): void {
    if (levelPriority[levelName] < levelPriority[level]) {
      return;
    }

    const record = createLogRecord({
      timestamp: now(),
      level: levelName,
      component,
      event,
      context,
      maxStringLength,
    });

    try {
      sink.write(formatLogRecord(record));
    } catch (error: unknown) {
      fallbackSink.write(
        formatLogRecord(
          createLogRecord({
            timestamp: now(),
            level: "error",
            component: "logger",
            event: "sink_failed",
            context: { cause: errorMessage(error) },
            maxStringLength,
          }),
        ),
      );
    }
  }

  return {
    debug: (component, event, context) => log("debug", component, event, context),
    info: (component, event, context) => log("info", component, event, context),
    warn: (component, event, context) => log("warn", component, event, context),
    error: (component, event, context) => log("error", component, event, context),
  };
}

export function parseLogLevel(value: string | undefined, fallback: LogLevel): LogLevel {
  switch (value) {
    case "debug":
    case "info":
    case "warn":
    case "error":
      return value;
    default:
      return fallback;
  }
}

export function resolveMainLogPath(logDirectory: string): string {
  return join(logDirectory, "main.log");
}

export function formatLogRecord(record: LogRecord): string {
  return `${JSON.stringify(record)}\n`;
}

export class StderrLogSink implements LogSink {
  constructor(private readonly stderr: Pick<NodeJS.WriteStream, "write"> = process.stderr) {}

  write(line: string): void {
    this.stderr.write(line);
  }
}

export class FileLogSink implements LogSink {
  constructor(
    private readonly options: {
      logFilePath: string;
      maxBytes?: number;
      maxFiles?: number;
    },
  ) {}

  write(line: string): void {
    const maxBytes = this.options.maxBytes ?? defaultMaxFileBytes;
    const maxFiles = this.options.maxFiles ?? defaultMaxFiles;
    mkdirSync(dirname(this.options.logFilePath), { recursive: true });
    this.rotateIfNeeded(Buffer.byteLength(line, "utf8"), maxBytes, maxFiles);
    appendFileSync(this.options.logFilePath, line, "utf8");
  }

  private rotateIfNeeded(nextBytes: number, maxBytes: number, maxFiles: number): void {
    if (!existsSync(this.options.logFilePath)) {
      return;
    }

    if (statSync(this.options.logFilePath).size + nextBytes <= maxBytes) {
      return;
    }

    for (let index = maxFiles - 1; index >= 1; index -= 1) {
      const source = `${this.options.logFilePath}.${index}`;
      const target = `${this.options.logFilePath}.${index + 1}`;
      if (existsSync(source)) {
        if (existsSync(target)) {
          unlinkSync(target);
        }
        renameSync(source, target);
      }
    }
    const firstRotatedLog = `${this.options.logFilePath}.1`;
    if (existsSync(firstRotatedLog)) {
      unlinkSync(firstRotatedLog);
    }
    renameSync(this.options.logFilePath, `${this.options.logFilePath}.1`);
  }
}

export class CompositeLogSink implements LogSink {
  constructor(private readonly sinks: LogSink[]) {}

  write(line: string): void {
    let firstError: unknown = null;
    for (const sink of this.sinks) {
      try {
        sink.write(line);
      } catch (error: unknown) {
        firstError ??= error;
      }
    }

    if (firstError) {
      throw firstError;
    }
  }
}

export class MemoryLogSink implements LogSink {
  readonly lines: string[] = [];
  readonly records: LogRecord[] = [];

  write(line: string): void {
    this.lines.push(line);
    this.records.push(JSON.parse(line) as LogRecord);
  }
}

export class NullLogSink implements LogSink {
  write(): void {
    // Intentionally empty for tests and callers that explicitly disable logs.
  }
}

function createDefaultSink(options: CreateAppLoggerOptions): LogSink {
  const sinks: LogSink[] = [];
  if (options.logDirectory) {
    sinks.push(
      new FileLogSink({
        logFilePath: resolveMainLogPath(options.logDirectory),
        maxBytes: options.maxFileBytes,
        maxFiles: options.maxFiles,
      }),
    );
  }

  if (options.isDevelopment) {
    sinks.push(new StderrLogSink(options.stderr));
  }

  if (sinks.length === 0) {
    return new StderrLogSink(options.stderr);
  }

  const firstSink = sinks[0];
  return sinks.length === 1 && firstSink ? firstSink : new CompositeLogSink(sinks);
}

function defaultLogLevel(isDevelopment: boolean): LogLevel {
  return isDevelopment ? "debug" : "info";
}

function createLogRecord({
  timestamp,
  level,
  component,
  event,
  context,
  maxStringLength,
}: {
  timestamp: string;
  level: LogLevel;
  component: string;
  event: string;
  context: Record<string, unknown>;
  maxStringLength: number;
}): LogRecord {
  return {
    timestamp,
    level,
    component,
    event,
    ...(sanitizeValue(context, maxStringLength) as Record<string, unknown>),
  };
}

function sanitizeValue(value: unknown, maxStringLength: number): unknown {
  if (typeof value === "string") {
    return truncateString(value, maxStringLength);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, maxStringLength));
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: truncateString(value.message, maxStringLength),
    };
  }

  if (isPlainObject(value)) {
    const sanitized: Record<string, unknown> = {};
    for (const [key, childValue] of Object.entries(value)) {
      sanitized[key] = sensitiveKeyPattern.test(key)
        ? "[REDACTED]"
        : sanitizeValue(childValue, maxStringLength);
    }
    return sanitized;
  }

  return value;
}

function truncateString(value: string, maxStringLength: number): string {
  if (value.length <= maxStringLength) {
    return value;
  }

  return `${value.slice(0, maxStringLength)}...`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && value.constructor === Object;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
