export function nodeEvalCommand(source: string): string {
  const encoded = Buffer.from(source, "utf8").toString("base64");
  return `node -e "eval(Buffer.from('${encoded}', 'base64').toString('utf8'))"`;
}

export function interruptFixtureCommand(readyMarker: string, handledMarker: string): string {
  return nodeEvalCommand(
    [
      'process.on("SIGINT", () => {',
      `  process.stdout.write(${JSON.stringify(`${handledMarker}\n`)});`,
      "  process.exit(0);",
      "});",
      `process.stdout.write(${JSON.stringify(`${readyMarker}\n`)});`,
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
}

export function alternateScreenCommand(marker: string): string {
  return nodeEvalCommand(
    [
      `process.stdout.write(String.fromCharCode(27) + ${JSON.stringify(`[?1049h${marker}`)});`,
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
}
