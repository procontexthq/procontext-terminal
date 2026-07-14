import { describe, expect, it } from "vitest";

import { createSessionId } from "@terminal/protocol";
import {
  encodeShellIntegrationMarker,
  formatShellIntegrationOsc,
  fullShellIntegrationCapabilities,
} from "@terminal/shell-integration";

import { TerminalModel } from "../src/terminal-model";

describe("TerminalModel", () => {
  it("parses ANSI output, Unicode cell widths, and wrapped rows", async () => {
    const model = new TerminalModel({ cols: 4, rows: 2, scrollback: 5_000 });
    model.setLifecycle("running");

    await model.write("\u001b[31mA界B\u001b[0mC");
    const observation = model.observe(createSessionId("session-unicode"));

    expect(observation.viewport.rows).toEqual([
      { row: 0, text: "A界B", wrapped: false },
      { row: 1, text: "C", wrapped: true },
    ]);
    expect(observation.cursor).toMatchObject({ x: 1, y: 1, visible: true });
  });

  it("retains normal-buffer scrollback and exposes shared viewport movement", async () => {
    const model = new TerminalModel({ cols: 20, rows: 2, scrollback: 5 });
    model.setLifecycle("running");

    await model.write("one\r\ntwo\r\nthree");
    const live = model.observe(createSessionId("session-scrollback"));

    expect(live.viewport).toMatchObject({
      atBottom: true,
      scrollbackRows: 1,
      offsetFromBottom: 0,
    });
    expect(model.scroll({ type: "edge", edge: "top" })).toBe(true);

    const historical = model.observe(createSessionId("session-scrollback"));
    expect(historical.viewport).toMatchObject({
      atTop: true,
      atBottom: false,
      offsetFromBottom: 1,
    });
    expect(historical.viewport.rows.map((row) => row.text)).toEqual(["one", "two"]);
  });

  it("captures wrapped rows, cursor, title, and alternate buffer state", async () => {
    const model = new TerminalModel({ cols: 5, rows: 2, scrollback: 5_000 });
    model.setLifecycle("running");

    await model.write("\u001b]0;Title\u0007abcdef\u001b[?25l\u001b[?1049hxy");
    const observation = model.observe(createSessionId("session-model"));

    expect(observation.title).toBe("Title");
    expect(observation.alternateScreen).toBe(true);
    expect(observation.cursor.visible).toBe(false);
    expect(observation.viewport.rows.some((row) => row.text.includes("xy"))).toBe(true);
  });

  it("increments once after each settled output write", async () => {
    const model = new TerminalModel({ cols: 80, rows: 24, scrollback: 5_000 });
    model.setLifecycle("running");
    const initial = model.version;

    const pending = model.write("hello");
    expect(model.version).toBe(initial);
    await pending;

    expect(model.version).toBe(initial + 1);
  });

  it("serializes a restorable framebuffer", async () => {
    const model = new TerminalModel({ cols: 80, rows: 24, scrollback: 5_000 });
    model.setLifecycle("running");
    await model.write("serialized state");

    expect(model.serialize()).toContain("serialized state");
  });

  it("commits trusted shell markers with terminal output as one observation version", async () => {
    const nonce = "AQEBAQEBAQEBAQEBAQEBAQ";
    const model = new TerminalModel({
      cols: 80,
      rows: 24,
      scrollback: 5_000,
      cwd: "/workspace",
      shellIntegrationNonce: nonce,
      now: () => new Date("2026-07-14T10:00:00.000Z"),
    });
    model.setLifecycle("running");
    const initialVersion = model.version;

    await model.write(
      [
        "visible",
        osc(nonce, "ready", "", JSON.stringify(fullShellIntegrationCapabilities)),
        osc(nonce, "prompt", "", "/workspace/packages"),
      ].join(""),
    );

    expect(model.version).toBe(initialVersion + 1);
    const observation = model.observe(createSessionId("session-integration"));
    expect(observation).toMatchObject({
      cwd: "/workspace/packages",
      shellIntegration: { status: "available" },
      command: { state: "idle" },
    });
    expect(observation.viewport.rows[0]).toMatchObject({ text: "visible" });
  });

  it("ignores nested markers with another nonce", async () => {
    const nonce = "AQEBAQEBAQEBAQEBAQEBAQ";
    const model = new TerminalModel({
      cols: 80,
      rows: 24,
      scrollback: 5_000,
      cwd: "/workspace",
      shellIntegrationNonce: nonce,
    });
    model.setLifecycle("running");

    await model.write(
      osc("AgICAgICAgICAgICAgICAg", "ready", "", JSON.stringify(fullShellIntegrationCapabilities)),
    );

    expect(model.observe(createSessionId("session-nested"))).toMatchObject({
      cwd: "/workspace",
      shellIntegration: { status: "initializing" },
      command: { state: "unknown" },
    });
  });
});

function osc(
  nonce: string,
  event: "ready" | "prompt" | "command-start" | "command-finish",
  commandId: string,
  payload: string,
): string {
  return formatShellIntegrationOsc(
    encodeShellIntegrationMarker({ nonce, event, commandId, payload }),
  );
}
