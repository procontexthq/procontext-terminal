import { describe, expect, it } from "vitest";

import { createSessionId } from "@terminal/protocol";

import { createTerminalPresentationRegistry } from "../../src/main/presentation-registry";

describe("terminal presentation registry", () => {
  it("allows one renderer view per session", () => {
    const registry = createTerminalPresentationRegistry();
    const sessionId = createSessionId("session-1");

    registry.open(sessionId, 7);
    registry.open(sessionId, 7);

    expect(registry.owns(sessionId, 7)).toBe(true);
    expect(() => registry.open(sessionId, 8)).toThrow(
      expect.objectContaining({ type: "view_unavailable", sessionId }),
    );
  });

  it("releases all views owned by a destroyed renderer", () => {
    const registry = createTerminalPresentationRegistry();
    const first = createSessionId("session-1");
    const second = createSessionId("session-2");
    registry.open(first, 7);
    registry.open(second, 7);

    expect(registry.removeRenderer(7)).toEqual([first, second]);
    expect(registry.owns(first, 7)).toBe(false);
    expect(registry.owns(second, 7)).toBe(false);
  });

  it("ignores close requests from non-owning renderers", () => {
    const registry = createTerminalPresentationRegistry();
    const sessionId = createSessionId("session-1");
    registry.open(sessionId, 7);

    expect(registry.close(sessionId, 8)).toBe(false);
    expect(registry.close(sessionId, 7)).toBe(true);
  });
});
