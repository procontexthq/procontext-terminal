import type { Stats } from "node:fs";

import {
  parseTerminalLinkTarget,
  type TerminalLinkPlatform,
  type TerminalLinkTarget,
} from "../shared/terminal-links";

type TerminalLinkOpenErrorType = "invalid_request" | "link_open_failed";

export class TerminalLinkOpenError extends Error {
  override readonly name = "TerminalLinkOpenError";

  constructor(
    readonly type: TerminalLinkOpenErrorType,
    message: string,
  ) {
    super(message);
  }
}

type FileSystemEntry = Pick<Stats, "isDirectory" | "isFile">;

export type TerminalLinkOpenerDependencies = {
  platform: TerminalLinkPlatform;
  openExternal(target: string): Promise<void>;
  showItemInFolder(target: string): void;
  statPath(target: string): Promise<FileSystemEntry>;
};

export type TerminalLinkOpenResult = { status: "opened" };

function invalidTarget(): TerminalLinkOpenError {
  return new TerminalLinkOpenError("invalid_request", "The terminal link target is invalid.");
}

function openFailed(): TerminalLinkOpenError {
  return new TerminalLinkOpenError("link_open_failed", "The terminal link could not be opened.");
}

function withoutLineAndColumn(target: string): string | null {
  const stripped = target.replace(/:\d+(?::\d+)?$/u, "");
  return stripped === target ? null : stripped;
}

async function resolveExistingPath(
  target: string,
  statPath: TerminalLinkOpenerDependencies["statPath"],
): Promise<string | null> {
  const candidates = [target];
  const stripped = withoutLineAndColumn(target);
  if (stripped !== null) candidates.push(stripped);

  for (const candidate of candidates) {
    try {
      const entry = await statPath(candidate);
      if (entry.isFile() || entry.isDirectory()) return candidate;
    } catch {
      // Treat filesystem errors uniformly; terminal output is not a trusted path source.
    }
  }
  return null;
}

export function createTerminalLinkOpener(dependencies: TerminalLinkOpenerDependencies) {
  return async (input: TerminalLinkTarget): Promise<TerminalLinkOpenResult> => {
    const parsed = parseTerminalLinkTarget(input.target, input.kind, dependencies.platform);
    if (parsed === null) throw invalidTarget();

    if (parsed.kind === "url") {
      try {
        await dependencies.openExternal(parsed.target);
      } catch {
        throw openFailed();
      }
      return { status: "opened" };
    }

    const existingPath = await resolveExistingPath(parsed.target, (target) =>
      dependencies.statPath(target),
    );
    if (existingPath === null) throw invalidTarget();

    try {
      dependencies.showItemInFolder(existingPath);
    } catch {
      throw openFailed();
    }
    return { status: "opened" };
  };
}
