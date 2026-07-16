import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const css = readFileSync(
  fileURLToPath(new URL("../../src/renderer/styles.css", import.meta.url)),
  "utf8",
);

describe("renderer theme contrast", () => {
  it("keeps small secondary text at WCAG AA contrast in every theme", () => {
    const selectors = [
      ":root",
      '.app-shell[data-theme="coder"]',
      '.app-shell[data-theme="gamer"]',
      '.app-shell[data-theme="classic"]',
    ];

    for (const selector of selectors) {
      const block = cssBlock(selector);
      const foreground = cssColor(block, "--text-dim");
      const background = cssColor(block, "--surface-raised");
      expect(contrastRatio(foreground, background), selector).toBeGreaterThanOrEqual(4.5);
    }
  });
});

function cssBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{(?<body>[^}]+)\\}`, "u").exec(css);
  if (!match?.groups?.body) throw new Error(`Missing CSS block ${selector}.`);
  return match.groups.body;
}

function cssColor(block: string, property: string): string {
  const match = new RegExp(`${property}:\\s*(?<value>#[0-9a-f]{6})`, "iu").exec(block);
  if (!match?.groups?.value) throw new Error(`Missing ${property}.`);
  return match.groups.value;
}

function contrastRatio(left: string, right: string): number {
  const bright = Math.max(relativeLuminance(left), relativeLuminance(right));
  const dark = Math.min(relativeLuminance(left), relativeLuminance(right));
  return (bright + 0.05) / (dark + 0.05);
}

function relativeLuminance(color: string): number {
  const channels = color
    .slice(1)
    .match(/.{2}/gu)
    ?.map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  if (!channels || channels.length !== 3) throw new Error(`Invalid color ${color}.`);
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}
