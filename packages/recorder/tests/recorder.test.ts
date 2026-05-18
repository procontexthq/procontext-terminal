import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createSessionId, type TerminalSessionSnapshot } from "@terminal/protocol";

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

function snapshot(sessionId: string): TerminalSessionSnapshot {
  return {
    sessionId: createSessionId(sessionId),
    state: "running",
    shell: "/bin/sh",
    cwd: "/tmp",
    cols: 80,
    rows: 24,
    title: null,
    createdBy: "human",
    createdAt: "2026-05-11T00:00:00.000Z",
    updatedAt: "2026-05-11T00:00:00.000Z",
  };
}
