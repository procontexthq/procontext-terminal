import { writeFile } from "node:fs/promises";
import { basename } from "node:path";

import {
  createTerminalError,
  type RecordingControlRequest,
  type RecordingExportFileResult,
  type TerminalRecordingExport,
} from "@terminal/protocol";

export type RecordingExportDependencies = {
  exportRecording(request: RecordingControlRequest): Promise<TerminalRecordingExport>;
  showSaveDialog(options: {
    title: string;
    defaultPath: string;
    filters: Array<{ name: string; extensions: string[] }>;
  }): Promise<{ canceled: boolean; filePath?: string }>;
  write?: (path: string, contents: string) => Promise<void>;
};

export async function exportRecordingToFile(
  request: RecordingControlRequest,
  dependencies: RecordingExportDependencies,
): Promise<RecordingExportFileResult> {
  try {
    const dialogResult = await dependencies.showSaveDialog({
      title: "Export terminal recording",
      defaultPath: `terminal-recording-${safeFilePart(request.sessionId)}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (dialogResult.canceled || !dialogResult.filePath) return { status: "cancelled" };

    const recording = await dependencies.exportRecording(request);
    const contents = `${JSON.stringify(recording, null, 2)}\n`;
    await (dependencies.write ?? writeFile)(dialogResult.filePath, contents);
    return { status: "saved", fileName: basename(dialogResult.filePath) };
  } catch (error: unknown) {
    throw createTerminalError("recording_failed", "Could not export terminal recording.", {
      sessionId: request.sessionId,
      operation: "recording.exportFile",
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function safeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/gu, "-");
}
