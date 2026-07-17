import { useEffect, useRef } from "react";
import type { ReactElement } from "react";

import type { UiThemePreference } from "@terminal/protocol";

export function FocusedSettingsThemeSelect({
  theme,
  pending,
  onChange,
}: {
  theme: UiThemePreference;
  pending: boolean;
  onChange: (theme: UiThemePreference) => void;
}): ReactElement {
  const selectRef = useRef<HTMLSelectElement>(null);
  const restoreFocus = useRef(false);

  useEffect(() => {
    if (pending || !restoreFocus.current) return;
    restoreFocus.current = false;
    if (
      document.activeElement === document.body ||
      document.activeElement === document.documentElement
    ) {
      selectRef.current?.focus();
    }
  }, [pending]);

  return (
    <label className="focused-settings-theme">
      Interface theme
      <select
        ref={selectRef}
        data-testid="theme-select"
        title="Applies and saves immediately"
        value={theme}
        disabled={pending}
        onChange={(event) => {
          restoreFocus.current = document.activeElement === event.currentTarget;
          onChange(parseUiTheme(event.target.value));
        }}
      >
        <option value="default">Default</option>
        <option value="coder">Coder</option>
        <option value="gamer">Gamer</option>
        <option value="classic">Classic</option>
      </select>
    </label>
  );
}

function parseUiTheme(value: string): UiThemePreference {
  return value === "coder" || value === "gamer" || value === "classic" ? value : "default";
}
