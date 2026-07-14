import type { ReactElement } from "react";

export function SessionSidebarToggle({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}): ReactElement {
  const label = `${open ? "Hide" : "Show"} terminal sessions`;
  return (
    <button
      type="button"
      className={`session-sidebar-toggle${open ? " is-active" : ""}`}
      aria-label={label}
      aria-expanded={open}
      title={label}
      data-testid="session-sidebar-toggle"
      onClick={onToggle}
    >
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <rect x="2.5" y="3" width="15" height="14" rx="2" />
        <path d="M7 3v14" />
        <path d="M4.5 6h1" />
        <path d="M4.5 9h1" />
      </svg>
    </button>
  );
}
