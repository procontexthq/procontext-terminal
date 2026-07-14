import { afterEach, describe, expect, it, vi } from "vitest";

import { createPermissionBroker } from "../../src/main/permission-broker";

afterEach(() => {
  vi.useRealTimers();
});

describe("permission broker", () => {
  it("lists pending requests and lets the first human resolution settle them", async () => {
    const onRequested = vi.fn();
    const onResolved = vi.fn();
    const broker = createPermissionBroker({ onRequested, onResolved, timeoutMs: 30_000 });
    const pending = broker.request({
      decisionId: "decision-allow",
      category: "termination",
      operation: "terminal.close",
    });

    expect(broker.list()).toEqual([
      expect.objectContaining({
        permissionId: "decision-allow",
        category: "termination",
        operation: "terminal.close",
      }),
    ]);
    expect(broker.resolve({ permissionId: "decision-allow", decision: "allow" })).toBe(true);
    expect(broker.resolve({ permissionId: "decision-allow", decision: "deny" })).toBe(false);
    await expect(pending).resolves.toBe("allow");
    expect(broker.list()).toEqual([]);
    expect(onRequested).toHaveBeenCalledOnce();
    expect(onResolved).toHaveBeenCalledWith({
      permissionId: "decision-allow",
      outcome: "allow",
    });
  });

  it("denies timed-out and cancelled requests without fixed sleeps", async () => {
    vi.useFakeTimers();
    const onResolved = vi.fn();
    const broker = createPermissionBroker({ onResolved, timeoutMs: 30_000 });
    const timedOut = broker.request({
      decisionId: "decision-timeout",
      category: "recording",
      operation: "terminal.recording.start",
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(timedOut).resolves.toBe("timeout");

    const abortController = new AbortController();
    const cancelled = broker.request(
      {
        decisionId: "decision-cancelled",
        category: "interaction",
        operation: "terminal.input",
      },
      abortController.signal,
    );
    abortController.abort();
    await expect(cancelled).resolves.toBe("cancelled");
    expect(onResolved).toHaveBeenCalledWith({
      permissionId: "decision-timeout",
      outcome: "timeout",
    });
    expect(onResolved).toHaveBeenCalledWith({
      permissionId: "decision-cancelled",
      outcome: "cancelled",
    });
  });

  it("rejects overflow before creating hidden pending requests", async () => {
    const onRequested = vi.fn();
    const broker = createPermissionBroker({ onRequested });
    const pending = Array.from({ length: 20 }, (_, index) =>
      broker.request({
        decisionId: `decision-${index}`,
        category: "observation",
        operation: "terminal.list",
      }),
    );

    await expect(
      broker.request({
        decisionId: "decision-overflow",
        category: "observation",
        operation: "terminal.list",
      }),
    ).resolves.toBe("cancelled");

    expect(broker.list()).toHaveLength(20);
    expect(broker.list()).not.toContainEqual(
      expect.objectContaining({ permissionId: "decision-overflow" }),
    );
    expect(onRequested).toHaveBeenCalledTimes(20);

    broker.dispose();
    await expect(Promise.all(pending)).resolves.toEqual(Array(20).fill("cancelled"));
  });

  it("cancels all pending requests when approval UI becomes unavailable", async () => {
    const onResolved = vi.fn();
    const broker = createPermissionBroker({ onResolved });
    const first = broker.request({
      decisionId: "decision-ui-first",
      category: "execution",
      operation: "terminal.create",
    });
    const second = broker.request({
      decisionId: "decision-ui-second",
      category: "termination",
      operation: "terminal.close",
    });

    broker.cancelPending();

    await expect(Promise.all([first, second])).resolves.toEqual(["cancelled", "cancelled"]);
    expect(broker.list()).toEqual([]);
    expect(onResolved).toHaveBeenCalledTimes(2);
  });
});
