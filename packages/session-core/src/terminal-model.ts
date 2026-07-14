import headlessModule from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";

import type {
  TerminalLifecycleState,
  TerminalObservation,
  TerminalPresentation,
  TerminalRecordingStatus,
  TerminalScrollAction,
} from "@terminal/protocol";
import { SHELL_INTEGRATION_OSC, ShellIntegrationTracker } from "@terminal/shell-integration";

const { Terminal } = headlessModule;

const headlessPresentation: TerminalPresentation = {
  state: "headless",
  windowVisible: false,
  windowFocused: false,
};

export type TerminalModelOptions = {
  cols: number;
  rows: number;
  scrollback: number;
  cwd?: string;
  shellIntegrationNonce?: string;
  now?: () => Date;
  onBell?: () => void;
};

export class TerminalModel {
  private readonly terminal;
  private readonly serializer;
  private readonly scrollback: number;
  private cursorVisible = true;
  private title: string | null = null;
  private unseenRows = 0;
  private lifecycle: TerminalLifecycleState = "creating";
  private presentation: TerminalPresentation = headlessPresentation;
  private readonly shellIntegration: ShellIntegrationTracker;
  private shellIntegrationChangedDuringWrite = false;
  private recording: TerminalRecordingStatus = { state: "inactive" };
  private observationVersion = 0;

  constructor(options: TerminalModelOptions) {
    this.scrollback = options.scrollback;
    this.terminal = new Terminal({
      cols: options.cols,
      rows: options.rows,
      scrollback: options.scrollback,
      allowProposedApi: true,
    });
    this.serializer = new SerializeAddon();
    this.shellIntegration = new ShellIntegrationTracker({
      cwd: options.cwd ?? process.cwd(),
      ...(options.shellIntegrationNonce ? { nonce: options.shellIntegrationNonce } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    this.terminal.loadAddon(this.serializer);
    this.terminal.onTitleChange((title) => {
      this.title = title;
    });
    this.terminal.onBell(() => options.onBell?.());
    this.terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
      if (params.includes(25)) this.cursorVisible = true;
      return false;
    });
    this.terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
      if (params.includes(25)) this.cursorVisible = false;
      return false;
    });
    this.terminal.parser.registerOscHandler(SHELL_INTEGRATION_OSC, (data) => {
      const result = this.shellIntegration.acceptOsc(data);
      if (result.changed) this.shellIntegrationChangedDuringWrite = true;
      return result.handled;
    });
  }

  get version(): number {
    return this.observationVersion;
  }

  get viewportY(): number {
    return this.terminal.buffer.active.viewportY;
  }

  get currentLifecycle(): TerminalLifecycleState {
    return this.lifecycle;
  }

  get currentTitle(): string | null {
    return this.title;
  }

  get currentCwd(): string {
    return this.shellIntegration.snapshot.cwd;
  }

  get currentPresentation(): TerminalPresentation {
    return this.presentation;
  }

  get currentShellIntegration() {
    return this.shellIntegration.snapshot.integration;
  }

  get currentCommand() {
    return this.shellIntegration.snapshot.command;
  }

  get currentRecording(): TerminalRecordingStatus {
    return this.recording;
  }

  get dimensions(): { cols: number; rows: number } {
    return { cols: this.terminal.cols, rows: this.terminal.rows };
  }

  async write(data: string): Promise<{
    titleChanged: boolean;
    shellIntegrationChanged: boolean;
  }> {
    const buffer = this.terminal.buffer.active;
    const wasAtBottom = buffer.viewportY === buffer.baseY;
    const previousBaseY = buffer.baseY;
    const previousTitle = this.title;
    this.shellIntegrationChangedDuringWrite = false;
    await new Promise<void>((resolve) => {
      this.terminal.write(data, resolve);
    });
    const nextBuffer = this.terminal.buffer.active;
    if (!wasAtBottom && nextBuffer.type === "normal") {
      this.unseenRows += Math.max(0, nextBuffer.baseY - previousBaseY);
    }
    if (nextBuffer.viewportY === nextBuffer.baseY) {
      this.unseenRows = 0;
    }
    this.commit();
    return {
      titleChanged: previousTitle !== this.title,
      shellIntegrationChanged: this.shellIntegrationChangedDuringWrite,
    };
  }

  resize(cols: number, rows: number): void {
    if (cols === this.terminal.cols && rows === this.terminal.rows) return;
    this.terminal.resize(cols, rows);
    this.commit();
  }

  scroll(action: TerminalScrollAction): boolean {
    const before = this.viewportY;
    if (this.terminal.buffer.active.type === "alternate") return false;
    switch (action.type) {
      case "lines":
        this.terminal.scrollLines(action.delta);
        break;
      case "page":
        this.terminal.scrollPages(action.direction === "up" ? -1 : 1);
        break;
      case "edge":
        if (action.edge === "top") this.terminal.scrollToTop();
        else this.terminal.scrollToBottom();
        break;
    }
    return this.commitViewportChange(before);
  }

  reportViewport(viewportY: number): boolean {
    if (this.terminal.buffer.active.type === "alternate") return false;
    const before = this.viewportY;
    this.terminal.scrollToLine(viewportY);
    return this.commitViewportChange(before);
  }

  scrollToBottomForInput(): boolean {
    const before = this.viewportY;
    this.terminal.scrollToBottom();
    return this.commitViewportChange(before);
  }

  setLifecycle(lifecycle: TerminalLifecycleState): void {
    const commandChanged =
      lifecycle === "exited" || lifecycle === "failed"
        ? this.shellIntegration.markShellExited()
        : false;
    if (lifecycle === this.lifecycle && !commandChanged) return;
    this.lifecycle = lifecycle;
    this.commit();
  }

  markShellIntegrationTimedOut(): boolean {
    const changed = this.shellIntegration.markInitializationTimedOut();
    if (changed) this.commit();
    return changed;
  }

  setPresentation(presentation: TerminalPresentation): void {
    if (sameValue(this.presentation, presentation)) return;
    this.presentation = presentation;
    this.commit();
  }

  setRecording(recording: TerminalRecordingStatus): void {
    if (sameValue(this.recording, recording)) return;
    this.recording = recording;
    this.commit();
  }

  observe(sessionId: TerminalObservation["sessionId"]): TerminalObservation {
    const buffer = this.terminal.buffer.active;
    const cursorAbsoluteY = buffer.baseY + buffer.cursorY;
    const cursorY = cursorAbsoluteY - buffer.viewportY;
    const rows = Array.from({ length: this.terminal.rows }, (_, row) => {
      const line = buffer.getLine(buffer.viewportY + row);
      return {
        row,
        text: line?.translateToString(true, 0, this.terminal.cols) ?? "",
        wrapped: line?.isWrapped ?? false,
      };
    });
    const offsetFromBottom = Math.max(0, buffer.baseY - buffer.viewportY);
    return {
      sessionId,
      version: this.observationVersion,
      lifecycle: this.lifecycle,
      cwd: this.currentCwd,
      dimensions: this.dimensions,
      viewport: {
        rows,
        offsetFromBottom,
        atTop: buffer.viewportY === 0,
        atBottom: offsetFromBottom === 0,
        scrollbackRows: buffer.type === "normal" ? Math.min(buffer.baseY, this.scrollback) : 0,
        unseenRows: buffer.type === "normal" ? this.unseenRows : 0,
      },
      cursor: {
        x: buffer.cursorX,
        y: Math.max(0, cursorY),
        visible: this.cursorVisible && cursorY >= 0 && cursorY < this.terminal.rows,
      },
      alternateScreen: buffer.type === "alternate",
      title: this.title,
      shellIntegration: this.currentShellIntegration,
      command: this.currentCommand,
      presentation: this.presentation,
      recording: this.recording,
    };
  }

  serialize(): string {
    return this.serializer.serialize({ scrollback: this.scrollback });
  }

  dispose(): void {
    this.serializer.dispose();
    this.terminal.dispose();
  }

  private commitViewportChange(previousViewportY: number): boolean {
    if (this.viewportY === previousViewportY) return false;
    if (this.terminal.buffer.active.viewportY === this.terminal.buffer.active.baseY) {
      this.unseenRows = 0;
    }
    this.commit();
    return true;
  }

  private commit(): void {
    this.observationVersion += 1;
  }
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
