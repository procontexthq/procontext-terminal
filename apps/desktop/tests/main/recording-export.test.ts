import { describe, expect, it, vi } from "vitest";

import { createSessionId } from "@terminal/protocol";

import { exportRecordingToFile } from "../../src/main/recording-export";

const sessionId = createSessionId("session-export");

describe("recording file export", () => {
  it("does not load transcript data when the native dialog is cancelled", async () => {
    const exportRecording = vi.fn();
    const write = vi.fn();

    await expect(
      exportRecordingToFile(
        { sessionId },
        {
          exportRecording,
          showSaveDialog: () => Promise.resolve({ canceled: true }),
          write,
        },
      ),
    ).resolves.toEqual({ status: "cancelled" });

    expect(exportRecording).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("writes the recording in main and returns only the selected file name", async () => {
    const write = vi.fn(() => Promise.resolve());
    const recording = {
      schemaVersion: 1 as const,
      sessionId,
      exportedAt: "2026-07-14T00:00:00.000Z",
      events: [],
    };

    await expect(
      exportRecordingToFile(
        { sessionId },
        {
          exportRecording: () => Promise.resolve(recording),
          showSaveDialog: () =>
            Promise.resolve({ canceled: false, filePath: "/private/path/recording.json" }),
          write,
        },
      ),
    ).resolves.toEqual({ status: "saved", fileName: "recording.json" });

    expect(write).toHaveBeenCalledWith(
      "/private/path/recording.json",
      `${JSON.stringify(recording, null, 2)}\n`,
    );
  });

  it("maps dialog and filesystem failures to a recording domain error", async () => {
    await expect(
      exportRecordingToFile(
        { sessionId },
        {
          exportRecording: vi.fn(),
          showSaveDialog: () => Promise.reject(new Error("dialog unavailable")),
        },
      ),
    ).rejects.toMatchObject({
      type: "recording_failed",
      sessionId,
      operation: "recording.exportFile",
    });
  });
});
