import { describe, expect, it } from "vitest";

import { createSessionId } from "@terminal/protocol";

import { TerminalModel } from "../src/terminal-model";

describe("TerminalModel", () => {
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
});
