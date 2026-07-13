export {
  NodeCapturedProcessHost,
  type CapturedProcess,
  type CapturedProcessExitEvent,
  type CapturedProcessHost,
  type CapturedProcessObserver,
  type CapturedProcessSpawnRequest,
} from "./captured-process-host.js";
export { ManagedTerminalSession, type TerminalRecorder } from "./managed-session.js";
export {
  TerminalOperationManager,
  type TerminalOperationManagerOptions,
  type TerminalOperationShutdownResult,
} from "./operation-manager.js";
export { SessionRecording } from "./session-recording.js";
export { TerminalSessionManager } from "./session-manager.js";
export type {
  CreateCommandSessionRequest,
  TerminalSessionManagerOptions,
  TerminalSessionShutdownResult,
} from "./session-manager.js";
export { TerminalModel } from "./terminal-model.js";
