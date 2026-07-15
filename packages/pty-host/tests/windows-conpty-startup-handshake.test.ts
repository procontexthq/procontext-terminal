import { describe, expect, it } from "vitest";

import { WindowsConptyStartupHandshake } from "../src/windows-conpty-startup-handshake";

const DEVICE_ATTRIBUTES_QUERY = "\u001b[c";
const XTERM_DEVICE_ATTRIBUTES_RESPONSE = "\u001b[?1;2c";

describe("WindowsConptyStartupHandshake", () => {
  it("answers and removes the bundled console startup query", () => {
    const handshake = new WindowsConptyStartupHandshake();

    expect(handshake.accept(`\u001b[1t${DEVICE_ATTRIBUTES_QUERY}\u001b[?1004h`)).toEqual({
      output: "\u001b[1t\u001b[?1004h",
      response: XTERM_DEVICE_ATTRIBUTES_RESPONSE,
    });
  });

  it("recognizes a startup query split across output chunks", () => {
    const handshake = new WindowsConptyStartupHandshake();

    expect(handshake.accept("\u001b[1t\u001b[")).toEqual({ output: "\u001b[1t" });
    expect(handshake.accept("c\u001b[?1004h")).toEqual({
      output: "\u001b[?1004h",
      response: XTERM_DEVICE_ATTRIBUTES_RESPONSE,
    });
  });

  it("becomes transparent after answering the first query", () => {
    const handshake = new WindowsConptyStartupHandshake();

    handshake.accept(DEVICE_ATTRIBUTES_QUERY);

    expect(handshake.accept(`after${DEVICE_ATTRIBUTES_QUERY}`)).toEqual({
      output: `after${DEVICE_ATTRIBUTES_QUERY}`,
    });
  });

  it("does not intercept a query after the bounded startup prefix", () => {
    const handshake = new WindowsConptyStartupHandshake();
    const prefix = "x".repeat(64);

    expect(handshake.accept(prefix)).toEqual({ output: prefix });
    expect(handshake.accept(DEVICE_ATTRIBUTES_QUERY)).toEqual({
      output: DEVICE_ATTRIBUTES_QUERY,
    });
  });

  it("preserves a partial query when the stream ends", () => {
    const handshake = new WindowsConptyStartupHandshake();

    expect(handshake.accept("before\u001b[")).toEqual({ output: "before" });
    expect(handshake.finish()).toBe("\u001b[");
  });
});
