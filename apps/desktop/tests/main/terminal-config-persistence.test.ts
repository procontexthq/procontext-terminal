import { describe, expect, it, vi } from "vitest";

import { defaultTerminalConfig } from "@terminal/config";
import type { TerminalConfig } from "@terminal/protocol";

import {
  applyTerminalConfigMutation,
  createQueuedTerminalConfigPersistence,
} from "../../src/main/terminal-config-persistence";

describe("terminal config persistence", () => {
  it("applies UI themes as terminal appearance presets", () => {
    const config = applyTerminalConfigMutation(defaultTerminalConfig(), {
      type: "ui-theme",
      theme: "gamer",
    });

    expect(config).toMatchObject({
      ui: { theme: "gamer" },
      terminal: {
        fontFamily:
          '"Share Tech Mono", ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
        theme: { background: "#07100d" },
      },
    });
  });

  it("merges deferred field-specific saves against the latest committed config", async () => {
    let config = defaultTerminalConfig();
    const firstWrite = deferred<void>();
    const writes: TerminalConfig[] = [];
    const persist = vi.fn(async (next: TerminalConfig) => {
      writes.push(next);
      if (writes.length === 1) await firstWrite.promise;
    });
    const persistence = createQueuedTerminalConfigPersistence({
      getConfig: () => config,
      setConfig: (next) => {
        config = next;
      },
      persist,
    });

    const themeSave = persistence.save({ type: "ui-theme", theme: "gamer" });
    await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce());

    const focused = {
      terminal: {
        ...config.terminal,
        fontFamily: "User Mono",
        fontSize: 17,
        scrollback: 12_000,
        theme: { ...config.terminal.theme, background: "#112233" },
      },
      shell: config.shell,
      accessibility: { ...config.accessibility, reducedMotion: true },
      recording: { state: "enabled" as const, redactedPatterns: ["token"] },
      defaultPresentation: "background" as const,
    };
    const focusedSave = persistence.save({ type: "focused-settings", settings: focused });
    const policy = { ...config.agentPolicy, execution: "ask" as const };
    const policySave = persistence.save({ type: "agent-policy", policy });

    firstWrite.resolve();
    await Promise.all([themeSave, focusedSave, policySave]);

    expect(writes).toHaveLength(3);
    expect(config).toMatchObject({
      ui: { theme: "gamer" },
      terminal: {
        fontFamily: "User Mono",
        fontSize: 17,
        scrollback: 12_000,
        theme: { background: "#112233" },
      },
      accessibility: { reducedMotion: true },
      recording: { state: "enabled", redactedPatterns: ["token"] },
      defaultPresentation: "background",
      agentPolicy: { execution: "ask" },
    });
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
