import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createSessionId, type TerminalSessionSummary } from "@terminal/protocol";

import { FileTerminalRecorder, createPatternRedactor } from "../src/index";

describe("FileTerminalRecorder", () => {
  it("records only explicitly enabled sessions and redacts before export", async () => {
    const directory = await mkdtemp(join(tmpdir(), "terminal-recorder-"));
    try {
      const recorder = new FileTerminalRecorder({
        directory,
        now: () => "2026-05-11T00:00:00.000Z",
        redactors: [createPatternRedactor(["secret"])],
      });
      const session = snapshot("session-1");
      await recorder.record({
        type: "pty.output",
        sessionId: session.sessionId,
        at: "2026-05-11T00:00:00.000Z",
        data: "ignored secret",
      });
      await recorder.start(session);
      await recorder.record({
        type: "pty.output",
        sessionId: session.sessionId,
        at: "2026-05-11T00:00:01.000Z",
        data: "visible secret",
      });
      await recorder.stop(session.sessionId);
      await recorder.record({
        type: "pty.output",
        sessionId: session.sessionId,
        at: "2026-05-11T00:00:02.000Z",
        data: "ignored after stop",
      });

      const exported = await recorder.export(session.sessionId);

      expect(exported.events).toHaveLength(2);
      expect(exported.events[0]).toMatchObject({ type: "session.created" });
      expect(exported.events[1]).toMatchObject({
        type: "pty.output",
        data: "visible [redacted]",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("writes versioned JSONL recordings and redacts before persistence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "terminal-recorder-"));
    try {
      const recorder = new FileTerminalRecorder({
        directory,
        now: () => "2026-05-11T00:00:00.000Z",
        redactors: [createPatternRedactor(["secret"])],
      });
      const session = snapshot("session-jsonl");

      await recorder.start(session);
      await recorder.record({
        type: "pty.output",
        sessionId: session.sessionId,
        at: "2026-05-11T00:00:01.000Z",
        data: "visible secret",
      });

      const raw = await readFile(recordingPath(directory, session.sessionId), "utf8");
      const lines = raw
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      expect(lines[0]).toEqual({
        type: "recording.header",
        schemaVersion: 1,
        sessionId: session.sessionId,
      });
      expect(lines[1]).toMatchObject({ type: "session.created", sessionId: session.sessionId });
      expect(lines[2]).toMatchObject({
        type: "pty.output",
        data: "visible [redacted]",
      });
      expect(raw).not.toContain("visible secret");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("exports legacy JSON array recordings for compatibility", async () => {
    const directory = await mkdtemp(join(tmpdir(), "terminal-recorder-"));
    try {
      const session = snapshot("session-legacy");
      await writeFile(
        recordingPath(directory, session.sessionId),
        `${JSON.stringify([
          {
            type: "pty.output",
            sessionId: session.sessionId,
            at: "2026-05-11T00:00:01.000Z",
            data: "legacy output",
          },
        ])}\n`,
        "utf8",
      );
      const recorder = new FileTerminalRecorder({
        directory,
        now: () => "2026-05-11T00:00:02.000Z",
      });

      await expect(recorder.export(session.sessionId)).resolves.toMatchObject({
        schemaVersion: 1,
        events: [{ type: "pty.output", data: "legacy output" }],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not append new events to existing legacy JSON array recordings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "terminal-recorder-"));
    try {
      const session = snapshot("session-legacy-write");
      const legacyRecording = `${JSON.stringify([
        {
          type: "pty.output",
          sessionId: session.sessionId,
          at: "2026-05-11T00:00:01.000Z",
          data: "legacy output",
        },
      ])}\n`;
      await writeFile(recordingPath(directory, session.sessionId), legacyRecording, "utf8");
      const recorder = new FileTerminalRecorder({ directory });

      await expect(recorder.start(session)).rejects.toThrow(/invalid header/);
      await recorder.record({
        type: "pty.output",
        sessionId: session.sessionId,
        at: "2026-05-11T00:00:02.000Z",
        data: "new output",
      });

      await expect(readFile(recordingPath(directory, session.sessionId), "utf8")).resolves.toBe(
        legacyRecording,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails export for corrupted recording data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "terminal-recorder-"));
    try {
      const session = snapshot("session-corrupt");
      await writeFile(
        recordingPath(directory, session.sessionId),
        `${JSON.stringify({
          type: "recording.header",
          schemaVersion: 1,
          sessionId: session.sessionId,
        })}\n${JSON.stringify({ type: "pty.output", sessionId: session.sessionId })}\n`,
        "utf8",
      );
      const recorder = new FileTerminalRecorder({ directory });

      await expect(recorder.export(session.sessionId)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves append order when events are recorded concurrently", async () => {
    const directory = await mkdtemp(join(tmpdir(), "terminal-recorder-"));
    try {
      const recorder = new FileTerminalRecorder({
        directory,
        now: () => "2026-05-11T00:00:00.000Z",
      });
      const session = snapshot("session-ordered");
      await recorder.start(session);

      await Promise.all(
        Array.from({ length: 20 }, (_value, index) =>
          recorder.record({
            type: "pty.output",
            sessionId: session.sessionId,
            at: `2026-05-11T00:00:${String(index + 1).padStart(2, "0")}.000Z`,
            data: `chunk-${index}`,
          }),
        ),
      );

      const exported = await recorder.export(session.sessionId);

      expect(exported.events.slice(1).map((event) => ("data" in event ? event.data : ""))).toEqual(
        Array.from({ length: 20 }, (_value, index) => `chunk-${index}`),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("updates redactors without disabling active recordings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "terminal-recorder-"));
    try {
      const recorder = new FileTerminalRecorder({
        directory,
        now: () => "2026-05-11T00:00:00.000Z",
        redactors: [createPatternRedactor(["old-secret"])],
      });
      const session = snapshot("session-updated");
      await recorder.start(session);
      await recorder.record({
        type: "pty.output",
        sessionId: session.sessionId,
        at: "2026-05-11T00:00:01.000Z",
        data: "old-secret before update",
      });

      recorder.updateRedactors([createPatternRedactor(["new-secret"])]);
      await recorder.record({
        type: "pty.output",
        sessionId: session.sessionId,
        at: "2026-05-11T00:00:02.000Z",
        data: "new-secret after update",
      });

      const exported = await recorder.export(session.sessionId);

      expect(exported.events.slice(1).map((event) => ("data" in event ? event.data : ""))).toEqual([
        "[redacted] before update",
        "[redacted] after update",
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function snapshot(sessionId: string): TerminalSessionSummary {
  return {
    sessionId: createSessionId(sessionId),
    lifecycle: "running",
    shell: "/bin/sh",
    cwd: "/tmp",
    dimensions: { cols: 80, rows: 24 },
    title: null,
    createdBy: "human",
    createdAt: "2026-05-11T00:00:00.000Z",
    updatedAt: "2026-05-11T00:00:00.000Z",
    observationVersion: 1,
    presentation: {
      state: "headless",
      windowVisible: false,
      windowFocused: false,
    },
    shellIntegration: {
      status: "unavailable",
      capabilities: {
        prompt: false,
        commandStart: false,
        commandFinish: false,
        commandLine: false,
        exitCode: false,
        cwd: false,
      },
    },
    command: { state: "unknown" },
    recording: { state: "inactive" },
  };
}

function recordingPath(directory: string, sessionId: string): string {
  return join(directory, `${encodeURIComponent(sessionId)}.json`);
}
