export type TerminalLinkKind = "url" | "path";

export type TerminalLinkTarget = {
  kind: TerminalLinkKind;
  target: string;
};

export type TerminalLinkCandidate = TerminalLinkTarget & {
  startIndex: number;
  endIndex: number;
};

export type TerminalLinkPlatform = "darwin" | "linux" | "win32";

const MAX_LINK_LENGTH = 4096;
const URL_CANDIDATE_PATTERN = /https?:\/\/[^\s<>"']+/giu;
const POSIX_PATH_CANDIDATE_PATTERN = /(^|[\s([{"'=])((?:\/(?!\/))[^\s<>"']+)/gu;
const WINDOWS_PATH_CANDIDATE_PATTERN = /(^|[\s([{"'=])([a-z]:[\\/][^\s<>"']+)/giu;
const POSIX_QUOTED_PATH_CANDIDATE_PATTERN = /(["'])((?:\/(?!\/))[^<>"']+)\1/gu;
const WINDOWS_QUOTED_PATH_CANDIDATE_PATTERN = /(["'])([a-z]:[\\/][^<>"']+)\1/giu;
const TRAILING_TERMINAL_PUNCTUATION = /[.,;!?]+$/u;

function trimCandidate(candidate: string): string {
  let result = candidate.replace(TRAILING_TERMINAL_PUNCTUATION, "");

  result = trimUnbalancedClosingCharacter(result, "(", ")");
  result = trimUnbalancedClosingCharacter(result, "[", "]");
  result = trimUnbalancedClosingCharacter(result, "{", "}");

  return result;
}

function trimUnbalancedClosingCharacter(value: string, opening: string, closing: string): string {
  let result = value;
  while (result.endsWith(closing)) {
    const openCount = [...result].filter((character) => character === opening).length;
    const closeCount = [...result].filter((character) => character === closing).length;
    if (closeCount <= openCount) break;
    result = result.slice(0, -1);
  }
  return result;
}

function isSafeLinkValue(target: string): boolean {
  return target.length > 0 && target.length <= MAX_LINK_LENGTH && !containsControlCharacter(target);
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || (code >= 127 && code <= 159)) return true;
  }
  return false;
}

function isLocalAbsolutePath(target: string, platform: TerminalLinkPlatform): boolean {
  if (platform === "win32") {
    if (target.startsWith("\\\\") || target.startsWith("//")) return false;
    return /^[a-z]:[\\/](?![\\/])/iu.test(target);
  }

  return target.startsWith("/") && !target.startsWith("//");
}

export function parseTerminalLinkTarget(
  target: string,
  kind: TerminalLinkKind,
  platform: TerminalLinkPlatform,
): TerminalLinkTarget | null {
  if (!isSafeLinkValue(target)) return null;

  if (kind === "path") {
    return isLocalAbsolutePath(target, platform) ? { kind, target } : null;
  }

  try {
    const url = new URL(target);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.hostname.length === 0
    ) {
      return null;
    }
    return { kind, target };
  } catch {
    return null;
  }
}

function overlapsExistingCandidate(
  startIndex: number,
  endIndex: number,
  candidates: readonly TerminalLinkCandidate[],
): boolean {
  return candidates.some(
    (candidate) => startIndex < candidate.endIndex && endIndex > candidate.startIndex,
  );
}

function appendMatches(
  line: string,
  pattern: RegExp,
  kind: TerminalLinkKind,
  platform: TerminalLinkPlatform,
  candidates: TerminalLinkCandidate[],
  captureIndex = 0,
  trimPunctuation = true,
): void {
  pattern.lastIndex = 0;
  for (const match of line.matchAll(pattern)) {
    const rawTarget = match[captureIndex];
    if (rawTarget === undefined || match.index === undefined) continue;

    const target = trimPunctuation ? trimCandidate(rawTarget) : rawTarget;
    const prefixLength = captureIndex === 0 ? 0 : (match[1]?.length ?? 0);
    const startIndex = match.index + prefixLength;
    const endIndex = startIndex + target.length;
    if (target.length === 0 || overlapsExistingCandidate(startIndex, endIndex, candidates))
      continue;

    const parsed = parseTerminalLinkTarget(target, kind, platform);
    if (parsed === null) continue;
    candidates.push({ ...parsed, startIndex, endIndex });
  }
}

export function findTerminalLinkCandidates(
  line: string,
  platform: TerminalLinkPlatform,
): TerminalLinkCandidate[] {
  const candidates: TerminalLinkCandidate[] = [];
  appendMatches(line, URL_CANDIDATE_PATTERN, "url", platform, candidates);
  appendMatches(
    line,
    platform === "win32"
      ? WINDOWS_QUOTED_PATH_CANDIDATE_PATTERN
      : POSIX_QUOTED_PATH_CANDIDATE_PATTERN,
    "path",
    platform,
    candidates,
    2,
    false,
  );
  appendMatches(
    line,
    platform === "win32" ? WINDOWS_PATH_CANDIDATE_PATTERN : POSIX_PATH_CANDIDATE_PATTERN,
    "path",
    platform,
    candidates,
    2,
  );
  return candidates.sort((left, right) => left.startIndex - right.startIndex);
}
