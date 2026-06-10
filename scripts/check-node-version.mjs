const [major] = process.versions.node.split(".").map(Number);

if (major !== 24) {
  console.error(
    [
      `Unsupported Node.js version: ${process.version}.`,
      "Use Node.js 24 for this workspace.",
      "If you use nvm, run: nvm install 24 && nvm use",
    ].join("\n"),
  );
  process.exit(1);
}
