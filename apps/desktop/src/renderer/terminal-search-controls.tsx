import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from "react";

import type { TerminalSearchTarget } from "./terminal-search";

type SearchAnnouncement = {
  id: number;
  text: string;
};

export function TerminalSearchControls({
  active,
  target,
  onRequestTerminalFocus,
}: {
  active: boolean;
  target: TerminalSearchTarget;
  onRequestTerminalFocus: () => void;
}): ReactElement | null {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [announcement, setAnnouncement] = useState<SearchAnnouncement | null>(null);
  const announcementId = useRef(0);
  const input = useRef<HTMLInputElement | null>(null);

  const announceResult = useCallback((found: boolean, direction?: "next" | "previous") => {
    announcementId.current += 1;
    const text = !found
      ? "No matches found."
      : direction === "next"
        ? "Next match found."
        : direction === "previous"
          ? "Previous match found."
          : "Match found.";
    setAnnouncement({
      id: announcementId.current,
      text,
    });
  }, []);

  const search = useCallback(
    (nextQuery: string, direction: "next" | "previous", incremental: boolean) => {
      if (!nextQuery) {
        target.clearDecorations();
        setAnnouncement(null);
        return;
      }
      const options = { incremental };
      const found =
        direction === "next"
          ? target.findNext(nextQuery, options)
          : target.findPrevious(nextQuery, options);
      announceResult(found, incremental ? undefined : direction);
    },
    [announceResult, target],
  );

  const closeSearch = useCallback(() => {
    target.clearDecorations();
    setOpen(false);
    setQuery("");
    setAnnouncement(null);
    onRequestTerminalFocus();
  }, [onRequestTerminalFocus, target]);

  useEffect(() => {
    if (!active) return undefined;
    const handleOpenShortcut = (event: KeyboardEvent): void => {
      if (!isOpenSearchShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (open) {
        input.current?.focus();
        input.current?.select();
        return;
      }
      setOpen(true);
    };
    window.addEventListener("keydown", handleOpenShortcut, { capture: true });
    return () => window.removeEventListener("keydown", handleOpenShortcut, true);
  }, [active, open]);

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    input.current?.select();
  }, [open]);

  useEffect(() => {
    if (active || !open) return;
    target.clearDecorations();
    setOpen(false);
    setQuery("");
    setAnnouncement(null);
  }, [active, open, target]);

  useEffect(() => () => target.clearDecorations(), [target]);

  if (!open) return null;

  const handleInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeSearch();
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    event.stopPropagation();
    search(query, event.shiftKey ? "previous" : "next", false);
  };

  return (
    <section className="terminal-search" role="search" aria-label="Terminal search">
      <input
        ref={input}
        type="search"
        value={query}
        aria-label="Search terminal scrollback"
        placeholder="Search"
        onChange={(event) => {
          const nextQuery = event.currentTarget.value;
          setQuery(nextQuery);
          search(nextQuery, "next", true);
        }}
        onKeyDown={handleInputKeyDown}
      />
      <button
        type="button"
        aria-label="Previous match"
        disabled={!query}
        onClick={() => search(query, "previous", false)}
      >
        &#8593;
      </button>
      <button
        type="button"
        aria-label="Next match"
        disabled={!query}
        onClick={() => search(query, "next", false)}
      >
        &#8595;
      </button>
      <button type="button" aria-label="Close terminal search" onClick={closeSearch}>
        &times;
      </button>
      <span className="terminal-search-status" aria-live="polite" aria-atomic="true">
        {announcement ? <span key={announcement.id}>{announcement.text}</span> : null}
      </span>
    </section>
  );
}

function isOpenSearchShortcut(event: KeyboardEvent): boolean {
  return (
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === "f"
  );
}
