import type { Dispatch, ReactElement, SetStateAction } from "react";

import type { FocusedTerminalSettings, TerminalShellProfile } from "@terminal/protocol";

export function FocusedSettingsShellProfiles({
  draft,
  setDraft,
  invalidFields,
  errorId,
}: {
  draft: FocusedTerminalSettings;
  setDraft: Dispatch<SetStateAction<FocusedTerminalSettings>>;
  invalidFields: readonly string[];
  errorId: string;
}): ReactElement {
  const updateProfile = (index: number, update: Partial<TerminalShellProfile>): void => {
    setDraft((current) => ({
      ...current,
      shell: {
        ...current.shell,
        profiles: current.shell.profiles.map((profile, candidateIndex) =>
          candidateIndex === index ? { ...profile, ...update } : profile,
        ),
      },
    }));
  };
  const errorProps = (testId: string) =>
    invalidFields.includes(testId)
      ? ({ "aria-describedby": errorId, "aria-invalid": true } as const)
      : {};

  return (
    <fieldset>
      <legend>Shell profiles</legend>
      <label>
        Default profile
        <select
          data-testid="shell-default-profile"
          {...errorProps("shell-default-profile")}
          value={draft.shell.defaultProfile ?? ""}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              shell: { ...current.shell, defaultProfile: event.target.value || null },
            }))
          }
        >
          <option value="">System default</option>
          {draft.shell.profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </select>
      </label>
      {draft.shell.profiles.map((profile, index) => (
        <article
          className="focused-settings-shell-profile"
          key={profile.id}
          aria-label={`Shell profile ${profile.name}`}
        >
          <label>
            Name
            <input
              data-testid={`shell-profile-name-${index}`}
              {...errorProps(`shell-profile-name-${index}`)}
              value={profile.name}
              onChange={(event) => updateProfile(index, { name: event.target.value })}
            />
          </label>
          <label>
            Shell
            <input
              data-testid={`shell-profile-shell-${index}`}
              {...errorProps(`shell-profile-shell-${index}`)}
              value={profile.shell}
              onChange={(event) => updateProfile(index, { shell: event.target.value })}
            />
          </label>
          <label>
            Working directory
            <input
              data-testid={`shell-profile-cwd-${index}`}
              {...errorProps(`shell-profile-cwd-${index}`)}
              value={profile.cwd ?? ""}
              onChange={(event) => updateProfile(index, { cwd: event.target.value || null })}
            />
          </label>
          <div className="focused-settings-shell-profile-actions">
            <button type="button" onClick={() => removeProfile(index, setDraft)}>
              Remove profile
            </button>
          </div>
        </article>
      ))}
      <button
        type="button"
        className="focused-settings-add-profile"
        onClick={() => addProfile(setDraft)}
      >
        Add profile
      </button>
    </fieldset>
  );
}

function addProfile(setDraft: Dispatch<SetStateAction<FocusedTerminalSettings>>): void {
  setDraft((current) => {
    const id = nextProfileId(current.shell.profiles);
    return {
      ...current,
      shell: {
        defaultProfile: current.shell.defaultProfile ?? id,
        profiles: [
          ...current.shell.profiles,
          { id, name: "New profile", shell: "shell", cwd: null, env: {} },
        ],
      },
    };
  });
}

function removeProfile(
  index: number,
  setDraft: Dispatch<SetStateAction<FocusedTerminalSettings>>,
): void {
  setDraft((current) => {
    const removed = current.shell.profiles[index];
    const profiles = current.shell.profiles.filter((_, candidateIndex) => candidateIndex !== index);
    return {
      ...current,
      shell: {
        profiles,
        defaultProfile:
          removed?.id === current.shell.defaultProfile
            ? (profiles[0]?.id ?? null)
            : current.shell.defaultProfile,
      },
    };
  });
}

function nextProfileId(profiles: TerminalShellProfile[]): string {
  let suffix = profiles.length + 1;
  while (profiles.some((profile) => profile.id === `profile-${suffix}`)) suffix += 1;
  return `profile-${suffix}`;
}
