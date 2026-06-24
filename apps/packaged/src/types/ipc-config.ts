/**
 * Open Design — IPC Configuration Types
 *
 * Defines the IPC connection state machine and reconnect
 * configuration for daemon ↔ renderer sidecar communication.
 *
 * @module types/ipc-config
 */

/** Connection state for the IPC heartbeat monitor. */
export enum IpcConnectionState {
  /** Sidecar IPC connection is established and healthy. */
  CONNECTED = "CONNECTED",

  /** Sidecar IPC connection has been lost. */
  DISCONNECTED = "DISCONNECTED",

  /** Reconnection is in progress (exponential backoff). */
  RECONNECTING = "RECONNECTING",

  /** Max retries exceeded; manual intervention required. */
  FAILED = "FAILED",
}

/** IPC events emitted by IpcHeartbeat. */
export enum IpcHeartbeatEvent {
  /** Connection established. */
  CONNECTED = "connected",

  /** Connection lost; reconnection will be attempted. */
  DISCONNECTED = "disconnected",

  /** Currently attempting to reconnect. */
  RECONNECTING = "reconnecting",

  /** All reconnect attempts exhausted. */
  FAILED = "failed",

  /** Heartbeat state changed. */
  STATE_CHANGE = "state-change",
}

/**
 * Configuration for the IPC heartbeat / reconnection mechanism.
 * All time values are in milliseconds.
 */
export interface IpcReconnectConfig {
  /** Initial delay before the first reconnection attempt (ms). */
  initialDelayMs: number;

  /** Maximum delay between reconnection attempts (ms). */
  maxDelayMs: number;

  /** Maximum number of reconnection attempts before FAILED state. */
  maxRetries: number;

  /** Interval between heartbeat PING messages (ms). */
  heartbeatIntervalMs: number;

  /** Timeout for a heartbeat PING before declaring disconnected (ms). */
  heartbeatTimeoutMs: number;

  /** URL of the daemon health endpoint for liveness probes. */
  livenessProbeUrl: string;
}

/** Default IPC reconnect configuration. */
export const DEFAULT_IPC_RECONNECT_CONFIG: IpcReconnectConfig = {
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
  maxRetries: 8,
  heartbeatIntervalMs: 5_000,
  heartbeatTimeoutMs: 15_000,
  livenessProbeUrl: "http://127.0.0.1:18924/health",
};
