import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactElement, WheelEvent } from "react";

import { terminalTabLabel, type TerminalTab } from "./terminal-tabs";

export function TerminalTabStrip({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onAdd,
}: {
  tabs: TerminalTab[];
  activeTabId: string | null;
  onSelect: (tabId: string) => void;
  onClose: (tab: TerminalTab, index: number) => void;
  onAdd: () => void;
}): ReactElement {
  const stripRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const [overflow, setOverflow] = useState({
    present: false,
    previous: false,
    next: false,
  });

  const updateOverflow = useCallback(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const maximum = Math.max(0, strip.scrollWidth - strip.clientWidth);
    setOverflow({
      present: maximum > 1,
      previous: strip.scrollLeft > 1,
      next: strip.scrollLeft < maximum - 1,
    });
  }, []);

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return undefined;
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateOverflow);
    observer?.observe(strip);
    window.addEventListener("resize", updateOverflow);
    updateOverflow();
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updateOverflow);
    };
  }, [tabs.length, updateOverflow]);

  useLayoutEffect(() => {
    if (!activeTabId) return;
    tabRefs.current.get(activeTabId)?.scrollIntoView?.({
      block: "nearest",
      inline: "nearest",
    });
    updateOverflow();
  }, [activeTabId, tabs.length, updateOverflow]);

  const scroll = useCallback(
    (direction: "previous" | "next") => {
      const strip = stripRef.current;
      if (!strip) return;
      const distance = Math.max(160, Math.round(strip.clientWidth * 0.7));
      strip.scrollLeft += direction === "previous" ? -distance : distance;
      updateOverflow();
    },
    [updateOverflow],
  );

  const handleWheel = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      const strip = stripRef.current;
      if (!strip || strip.scrollWidth <= strip.clientWidth) return;
      event.preventDefault();
      strip.scrollLeft += event.deltaY;
      updateOverflow();
    },
    [updateOverflow],
  );

  return (
    <div className="tab-navigation">
      <button
        type="button"
        className={`tab-scroll-button${overflow.present ? " is-visible" : ""}`}
        aria-label="Scroll tabs left"
        aria-hidden={!overflow.present}
        tabIndex={overflow.present ? 0 : -1}
        data-testid="tab-scroll-previous"
        disabled={!overflow.previous}
        onClick={() => scroll("previous")}
      >
        ‹
      </button>
      <div
        ref={stripRef}
        className="tab-strip"
        role="tablist"
        aria-label="Terminal tabs"
        data-testid="terminal-tab-strip"
        onScroll={updateOverflow}
        onWheel={handleWheel}
      >
        {tabs.map((tab, index) => (
          <div className={`tab-item${tab.id === activeTabId ? " is-active" : ""}`} key={tab.id}>
            <button
              ref={(element) => {
                if (element) tabRefs.current.set(tab.id, element);
                else tabRefs.current.delete(tab.id);
              }}
              type="button"
              role="tab"
              className={`tab-button${tab.id === activeTabId ? " is-active" : ""}`}
              data-terminal-tab="true"
              data-testid={`terminal-tab-${index}`}
              aria-selected={tab.id === activeTabId}
              onClick={() => onSelect(tab.id)}
            >
              {tab.hasUnreadBell ? <span className="tab-bell" aria-hidden="true" /> : null}
              <span className="tab-label">{terminalTabLabel(tab, index)}</span>
              <span
                className={`tab-status is-${tab.status}`}
                data-testid={tab.id === activeTabId ? "terminal-status" : undefined}
              >
                {tab.status}
              </span>
            </button>
            <button
              type="button"
              className="tab-close"
              data-testid={`close-tab-${index}`}
              aria-label={`Close ${terminalTabLabel(tab, index)}`}
              onClick={() => onClose(tab, index)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        className={`tab-scroll-button${overflow.present ? " is-visible" : ""}`}
        aria-label="Scroll tabs right"
        aria-hidden={!overflow.present}
        tabIndex={overflow.present ? 0 : -1}
        data-testid="tab-scroll-next"
        disabled={!overflow.next}
        onClick={() => scroll("next")}
      >
        ›
      </button>
      <button
        type="button"
        className="new-tab-button"
        data-testid="new-tab-button"
        aria-label="New terminal tab"
        title="New terminal tab"
        onClick={onAdd}
      >
        +
      </button>
    </div>
  );
}
