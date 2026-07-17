import { useEffect, useState } from "react";
import type { ReactElement } from "react";

import {
  agentPermissionCategories,
  type AgentPermissionCategory,
  type AgentPermissionMode,
  type AgentPolicyConfig,
} from "@terminal/protocol";

const categoryLabels: Record<AgentPermissionCategory, string> = {
  observation: "Observe",
  execution: "Create and run",
  interaction: "Interact",
  presentation: "Change presentation",
  recording: "Record",
  termination: "Terminate",
};

export function AgentPolicySettings({
  active,
  policy,
  onSave,
}: {
  active: boolean;
  policy: AgentPolicyConfig;
  onSave: (policy: AgentPolicyConfig) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(policy);
  const activityLabel = active ? "Agent active" : "Agent idle";
  const popoverId = "agent-policy-popover";

  useEffect(() => setDraft(policy), [policy]);

  return (
    <div className="agent-policy-settings">
      <button
        type="button"
        className={`agent-policy-toggle${active ? " is-agent-active" : ""}${open ? " is-active" : ""}`}
        aria-label={`${activityLabel}. Open agent policy settings`}
        aria-expanded={open}
        aria-controls={popoverId}
        title={`${activityLabel}. Open agent policy settings`}
        data-testid="agent-policy-toggle"
        onClick={() => setOpen((current) => !current)}
      >
        <span>{activityLabel}</span>
        <span className="agent-policy-chevron" aria-hidden="true" />
      </button>
      <span
        className="visually-hidden"
        data-testid="agent-activity"
        role="status"
        aria-live="polite"
      >
        {activityLabel}
      </span>
      {open ? (
        <section id={popoverId} className="agent-policy-popover" aria-label="Agent policy settings">
          <header>
            <strong>Agent permissions</strong>
            <p>{activityLabel}. Choose the default response for each coarse capability.</p>
          </header>
          {agentPermissionCategories.map((category) => (
            <label key={category}>
              <span>{categoryLabels[category]}</span>
              <select
                value={draft[category]}
                data-testid={`agent-policy-${category}`}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    [category]: parsePermissionMode(event.target.value),
                  }))
                }
              >
                <option value="allow">Allow</option>
                <option value="ask">Ask each time</option>
                <option value="deny">Deny</option>
              </select>
            </label>
          ))}
          <button
            type="button"
            className="agent-policy-save"
            data-testid="agent-policy-save"
            onClick={() => onSave(draft)}
          >
            Save policy
          </button>
        </section>
      ) : null}
    </div>
  );
}

function parsePermissionMode(value: string): AgentPermissionMode {
  return value === "ask" || value === "deny" ? value : "allow";
}
