import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CompositeLogSink,
  FileLogSink,
  MemoryLogSink,
  StderrLogSink,
  createAppLogger,
  formatLogRecord,
} from "../../src/main/logger";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "terminal-logger-"));
  tempDirs.push(directory);
  return directory;
}

describe("app logger", () => {
  it("formats structured JSONL records and filters by level", () => {
    const memory = new MemoryLogSink();
    const logger = createAppLogger({
      isDevelopment: false,
      sink: memory,
      level: "info",
      now: () => "2026-05-10T00:00:00.000Z",
    });

    logger.debug("app", "ignored");
    logger.info("app", "ready", { windowId: 1 });

    expect(memory.records).toEqual([
      {
        timestamp: "2026-05-10T00:00:00.000Z",
        level: "info",
        component: "app",
        event: "ready",
        windowId: 1,
      },
    ]);
    expect(memory.lines).toEqual([`${JSON.stringify(memory.records[0])}\n`]);
  });

  it("redacts sensitive keys and truncates long strings", () => {
    const memory = new MemoryLogSink();
    const logger = createAppLogger({
      isDevelopment: true,
      sink: memory,
      level: "debug",
      now: () => "2026-05-10T00:00:00.000Z",
      maxStringLength: 12,
    });

    logger.error("auth", "failed", {
      token: "secret-token",
      nested: {
        password: "secret-password",
        message: "this message is much too long",
      },
    });

    expect(memory.records[0]).toMatchObject({
      token: "[REDACTED]",
      nested: {
        password: "[REDACTED]",
        message: "this message...",
      },
    });
  });

  it("appends to file logs and rotates by size", () => {
    const directory = tempDir();
    const logPath = join(directory, "main.log");
    writeFileSync(logPath, "existing log line\n");
    writeFileSync(`${logPath}.1`, "previous one\n");
    writeFileSync(`${logPath}.2`, "previous two\n");
    writeFileSync(`${logPath}.3`, "previous three\n");
    const sink = new FileLogSink({ logFilePath: logPath, maxBytes: 10, maxFiles: 3 });

    sink.write(`${JSON.stringify({ event: "next" })}\n`);

    expect(readFileSync(`${logPath}.1`, "utf8")).toBe("existing log line\n");
    expect(readFileSync(`${logPath}.2`, "utf8")).toBe("previous one\n");
    expect(readFileSync(`${logPath}.3`, "utf8")).toBe("previous two\n");
    expect(readFileSync(logPath, "utf8")).toBe(`${JSON.stringify({ event: "next" })}\n`);
  });

  it("falls back when a sink fails without throwing from the logger", () => {
    const fallback = new MemoryLogSink();
    const failingSink = {
      write: vi.fn(() => {
        throw new Error("disk full");
      }),
    };
    const logger = createAppLogger({
      isDevelopment: false,
      sink: failingSink,
      fallbackSink: fallback,
      level: "debug",
      now: () => "2026-05-10T00:00:00.000Z",
    });

    expect(() => logger.info("app", "ready")).not.toThrow();
    expect(fallback.records).toEqual([
      expect.objectContaining({
        level: "error",
        component: "logger",
        event: "sink_failed",
        cause: "disk full",
      }),
    ]);
  });

  it("supports stderr and composite sinks", () => {
    const stderr = { write: vi.fn() };
    const memory = new MemoryLogSink();
    const sink = new CompositeLogSink([new StderrLogSink(stderr), memory]);
    const line = formatLogRecord({
      timestamp: "2026-05-10T00:00:00.000Z",
      level: "info",
      component: "app",
      event: "ready",
    });

    sink.write(line);

    expect(stderr.write).toHaveBeenCalledWith(line);
    expect(memory.lines).toEqual([line]);
  });
});
