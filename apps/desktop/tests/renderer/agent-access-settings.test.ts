// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentAccessKeyMetadata } from "@terminal/protocol";

import { AgentAccessSettings } from "../../src/renderer/agent-access-settings";

const initialMetadata: AgentAccessKeyMetadata = {
  fingerprint: "abcdef123456",
  createdAt: "2026-07-17T08:00:00.000Z",
};

describe("AgentAccessSettings", () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("renders only non-secret metadata, a static mask, and the rotation warning", () => {
    const fixture = renderAgentAccessSettings();
    const group = fixture.container.querySelector("fieldset");
    const mask = getElement(fixture.container, "agent-access-key-mask");
    const fingerprint = getElement(fixture.container, "agent-access-key-fingerprint");
    const createdAt = getElement<HTMLTimeElement>(fixture.container, "agent-access-key-created-at");

    expect(group?.querySelector("legend")?.textContent).toBe("Agent access");
    expect(mask.textContent).toBe("••••••••••••••••");
    expect(mask.getAttribute("aria-label")).toBe("Agent access key is hidden");
    expect(fingerprint.textContent).toContain(initialMetadata.fingerprint);
    expect(createdAt.dateTime).toBe(initialMetadata.createdAt);
    expect(fixture.container.textContent).toContain("Valid until you generate a new key.");
    expect(fixture.container.textContent).toContain("Connected agents will be disconnected.");
    expect(fixture.container.textContent).toContain("Terminal sessions remain running.");
    expect(Object.keys(initialMetadata).sort()).toEqual(["createdAt", "fingerprint"]);

    fixture.unmount();
  });

  it("copies through a metadata-only callback with busy and accessible success feedback", async () => {
    const pending = deferred<void>();
    const onCopy = vi.fn(() => pending.promise);
    const fixture = renderAgentAccessSettings({ onCopy });
    const copy = getButton(fixture.container, "agent-access-copy");
    const regenerate = getButton(fixture.container, "agent-access-regenerate");
    const feedback = getElement(fixture.container, "agent-access-feedback");

    act(() => copy.click());

    expect(onCopy).toHaveBeenCalledOnce();
    expect(onCopy).toHaveBeenCalledWith();
    expect(copy.disabled).toBe(true);
    expect(regenerate.disabled).toBe(true);
    expect(feedback.getAttribute("aria-live")).toBe("polite");
    expect(feedback.getAttribute("aria-atomic")).toBe("true");
    expect(feedback.textContent).toBe("Copying agent access key…");

    await act(async () => {
      pending.resolve();
      await pending.promise;
    });

    expect(copy.disabled).toBe(false);
    expect(regenerate.disabled).toBe(false);
    expect(feedback.textContent).toBe("Agent access key copied.");

    fixture.unmount();
  });

  it("reports copy failures without rendering sensitive error details", async () => {
    const failure = new Error("SENTINEL_SECRET_COPY_FAILURE");
    const onError = vi.fn();
    const fixture = renderAgentAccessSettings({
      onCopy: vi.fn(() => Promise.reject(failure)),
      onError,
    });

    await act(async () => {
      getButton(fixture.container, "agent-access-copy").click();
      await Promise.resolve();
    });

    expect(onError).toHaveBeenCalledWith(failure);
    expect(getElement(fixture.container, "agent-access-feedback").textContent).toBe(
      "Could not copy the agent access key.",
    );
    expect(fixture.container.textContent).not.toContain("SENTINEL_SECRET_COPY_FAILURE");
    expect(getButton(fixture.container, "agent-access-copy").disabled).toBe(false);
    expect(getButton(fixture.container, "agent-access-regenerate").disabled).toBe(false);

    fixture.unmount();
  });

  it("cancels safely, then confirms regeneration with busy and success feedback", async () => {
    const replacementMetadata: AgentAccessKeyMetadata = {
      fingerprint: "123456abcdef",
      createdAt: "2026-07-17T09:00:00.000Z",
    };
    const pending = deferred<AgentAccessKeyMetadata>();
    const onRegenerate = vi.fn(() => pending.promise);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const fixture = renderAgentAccessSettings({ onRegenerate });
    const copy = getButton(fixture.container, "agent-access-copy");
    const regenerate = getButton(fixture.container, "agent-access-regenerate");

    act(() => regenerate.click());

    expect(confirm).toHaveBeenCalledWith(
      "Generate a new agent access key? Connected agents will be disconnected. Terminal sessions remain running.",
    );
    expect(onRegenerate).not.toHaveBeenCalled();
    expect(copy.disabled).toBe(false);
    expect(regenerate.disabled).toBe(false);

    confirm.mockReturnValue(true);
    act(() => regenerate.click());

    expect(onRegenerate).toHaveBeenCalledOnce();
    expect(onRegenerate).toHaveBeenCalledWith();
    expect(copy.disabled).toBe(true);
    expect(regenerate.disabled).toBe(true);
    expect(getElement(fixture.container, "agent-access-feedback").textContent).toBe(
      "Generating a new agent access key…",
    );

    await act(async () => {
      pending.resolve(replacementMetadata);
      await pending.promise;
    });

    expect(copy.disabled).toBe(false);
    expect(regenerate.disabled).toBe(false);
    expect(getElement(fixture.container, "agent-access-key-fingerprint").textContent).toContain(
      replacementMetadata.fingerprint,
    );
    expect(
      getElement<HTMLTimeElement>(fixture.container, "agent-access-key-created-at").dateTime,
    ).toBe(replacementMetadata.createdAt);
    expect(getElement(fixture.container, "agent-access-feedback").textContent).toBe(
      "New agent access key generated. Connected agents were disconnected. Terminal sessions remain running.",
    );

    fixture.unmount();
  });

  it("reports regeneration failures without changing metadata or exposing error details", async () => {
    const failure = new Error("SENTINEL_SECRET_REGENERATION_FAILURE");
    const onError = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const fixture = renderAgentAccessSettings({
      onRegenerate: vi.fn(() => Promise.reject(failure)),
      onError,
    });

    await act(async () => {
      getButton(fixture.container, "agent-access-regenerate").click();
      await Promise.resolve();
    });

    expect(onError).toHaveBeenCalledWith(failure);
    expect(getElement(fixture.container, "agent-access-key-fingerprint").textContent).toContain(
      initialMetadata.fingerprint,
    );
    expect(getElement(fixture.container, "agent-access-feedback").textContent).toBe(
      "Could not generate a new agent access key. The current key is still active.",
    );
    expect(fixture.container.textContent).not.toContain("SENTINEL_SECRET_REGENERATION_FAILURE");
    expect(getButton(fixture.container, "agent-access-copy").disabled).toBe(false);
    expect(getButton(fixture.container, "agent-access-regenerate").disabled).toBe(false);

    fixture.unmount();
  });
});

type AgentAccessSettingsProps = {
  metadata: AgentAccessKeyMetadata;
  onCopy: () => Promise<void>;
  onRegenerate: () => Promise<AgentAccessKeyMetadata>;
  onError: (error: unknown) => void;
};

function renderAgentAccessSettings(overrides: Partial<AgentAccessSettingsProps> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const props: AgentAccessSettingsProps = {
    metadata: initialMetadata,
    onCopy: vi.fn(() => Promise.resolve()),
    onRegenerate: vi.fn(() => Promise.resolve(initialMetadata)),
    onError: vi.fn(),
    ...overrides,
  };

  act(() => root.render(createElement(AgentAccessSettings, props)));

  return {
    container,
    unmount: () => act(() => root.unmount()),
  };
}

function getElement<TElement extends HTMLElement = HTMLElement>(
  container: HTMLElement,
  testId: string,
): TElement {
  const element = container.querySelector<TElement>(`[data-testid="${testId}"]`);
  if (!element) throw new Error(`Expected element ${testId}.`);
  return element;
}

function getButton(container: HTMLElement, testId: string): HTMLButtonElement {
  const button = getElement<HTMLButtonElement>(container, testId);
  expect(button.type).toBe("button");
  return button;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
