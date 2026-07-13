import { describe, expect, it } from "vitest";

import {
  alternateScreenCommand,
  interruptFixtureCommand,
  nodeEvalCommand,
} from "./e2e/e2e-commands";

describe("Electron E2E command fixtures", () => {
  it("encodes JavaScript as a shell-neutral Base64 payload", () => {
    const command = nodeEvalCommand('process.stdout.write("fixture");');

    expect(decodeNodeEvalCommand(command)).toBe('process.stdout.write("fixture");');
  });

  it("waits for an explicit interrupt and reports when it was handled", () => {
    const source = decodeNodeEvalCommand(
      interruptFixtureCommand("INTERRUPT_READY", "INTERRUPT_HANDLED"),
    );

    expect(source).toContain('process.on("SIGINT"');
    expect(source).toContain("INTERRUPT_READY");
    expect(source).toContain("INTERRUPT_HANDLED");
    expect(source).toContain("process.exit(0)");
  });

  it("emits a real ESC byte for alternate-screen entry", () => {
    const source = decodeNodeEvalCommand(alternateScreenCommand("ALT_READY"));

    expect(source).toContain("String.fromCharCode(27)");
    expect(source).toContain("[?1049hALT_READY");
    expect(source).not.toContain("\\u001b");
  });
});

function decodeNodeEvalCommand(command: string): string {
  const match = /Buffer\.from\('([^']+)', 'base64'\)/.exec(command);
  if (!match?.[1]) throw new Error(`Could not read encoded Node command: ${command}`);
  return Buffer.from(match[1], "base64").toString("utf8");
}
