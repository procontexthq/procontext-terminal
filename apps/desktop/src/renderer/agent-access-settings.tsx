import { useEffect, useState } from "react";
import type { ReactElement } from "react";

import type { AgentAccessKeyMetadata } from "@terminal/protocol";

type AgentAccessSettingsProps = {
  metadata: AgentAccessKeyMetadata;
  onCopy: () => Promise<void>;
  onRegenerate: () => Promise<AgentAccessKeyMetadata>;
  onError: (error: unknown) => void;
};

type AgentAccessAction = "copy" | "regenerate";

const hiddenAccessKey = "\u2022".repeat(16);
const regenerateConfirmation =
  "Generate a new agent access key? Connected agents will be disconnected. Terminal sessions remain running.";

export function AgentAccessSettings({
  metadata,
  onCopy,
  onRegenerate,
  onError,
}: AgentAccessSettingsProps): ReactElement {
  const [currentMetadata, setCurrentMetadata] = useState(metadata);
  const [busy, setBusy] = useState<AgentAccessAction | null>(null);
  const [feedback, setFeedback] = useState("");

  useEffect(() => setCurrentMetadata(metadata), [metadata]);

  const copy = (): void => {
    setBusy("copy");
    setFeedback("Copying agent access key\u2026");
    void onCopy()
      .then(() => setFeedback("Agent access key copied."))
      .catch((error: unknown) => {
        setFeedback("Could not copy the agent access key.");
        onError(error);
      })
      .finally(() => setBusy(null));
  };

  const regenerate = (): void => {
    if (!window.confirm(regenerateConfirmation)) return;
    setBusy("regenerate");
    setFeedback("Generating a new agent access key\u2026");
    void onRegenerate()
      .then((replacement) => {
        setCurrentMetadata(replacement);
        setFeedback(
          "New agent access key generated. Connected agents were disconnected. Terminal sessions remain running.",
        );
      })
      .catch((error: unknown) => {
        setFeedback("Could not generate a new agent access key. The current key is still active.");
        onError(error);
      })
      .finally(() => setBusy(null));
  };

  return (
    <fieldset className="agent-access-settings">
      <legend>Agent access</legend>
      <div className="agent-access-key-summary">
        <span
          className="agent-access-key-mask"
          data-testid="agent-access-key-mask"
          aria-label="Agent access key is hidden"
        >
          {hiddenAccessKey}
        </span>
        <span data-testid="agent-access-key-fingerprint">
          Fingerprint: {currentMetadata.fingerprint}
        </span>
        <span>
          Created:{" "}
          <time dateTime={currentMetadata.createdAt} data-testid="agent-access-key-created-at">
            {formatTimestamp(currentMetadata.createdAt)}
          </time>
        </span>
        <span>Valid until you generate a new key.</span>
      </div>
      <p className="agent-access-warning">
        Connected agents will be disconnected. Terminal sessions remain running.
      </p>
      <div className="agent-access-actions">
        <button
          type="button"
          data-testid="agent-access-copy"
          disabled={busy !== null}
          onClick={copy}
        >
          Copy key
        </button>
        <button
          type="button"
          data-testid="agent-access-regenerate"
          disabled={busy !== null}
          onClick={regenerate}
        >
          Generate new key…
        </button>
      </div>
      <p
        className="agent-access-feedback"
        data-testid="agent-access-feedback"
        aria-live="polite"
        aria-atomic="true"
      >
        {feedback}
      </p>
    </fieldset>
  );
}

function formatTimestamp(value: string): string {
  return new Date(value).toLocaleString();
}
