/**
 * Open Design — Sidecars Module
 *
 * Manages sidecar process lifecycle (daemon, etc.) with IPC heartbeat
 * integration for automatic reconnection on connection loss.
 *
 * This module integrates IpcHeartbeat to monitor daemon connectivity
 * and trigger automatic reconnection with exponential backoff.
 *
 * @module sidecars
 */

import { EventEmitter } from "node:events";
import { IpcHeartbeat } from "./ipc-heartbeat.js";
import type { IpcReconnectConfig } from "./types/ipc-config.js";
import { PathUtils } from "./path-utils.js";

/** Log prefix for this module. */
const LOG_PREFIX = "[OpenDesign:Sidecars]";

/** Sidecar process state. */
export enum SidecarState {
  STOPPED = "STOPPED",
  STARTING = "STARTING",
  RUNNING = "RUNNING",
  STOPPING = "STOPPING",
  ERROR = "ERROR",
}

/** Configuration for a sidecar process. */
export interface SidecarConfig {
  /** Display name for logging. */
  name: string;

  /** Path to the sidecar executable. */
  executablePath: string;

  /** Command-line arguments for the executable. */
  args: string[];

  /** Health check URL for liveness probes. */
  healthUrl: string;

  /** Environment variables for the sidecar process. */
  env?: Record<string, string>;

  /** Timeout for sidecar startup (ms). */
  startupTimeoutMs: number;

  /** Timeout for health check polling (ms). */
  healthCheckTimeoutMs: number;

  /** IPC heartbeat configuration. */
  heartbeatConfig?: Partial<IpcReconnectConfig>;
}

/** Default sidecar configuration. */
const DEFAULT_SIDECAR_CONFIG: Partial<SidecarConfig> = {
  startupTimeoutMs: 30_000,
  healthCheckTimeoutMs: 30_000,
};

/** Sidecar event types. */
export enum SidecarEvent {
  STARTED = "sidecar:started",
  STOPPED = "sidecar:stopped",
  ERROR = "sidecar:error",
  CONNECTED = "sidecar:connected",
  DISCONNECTED = "sidecar:disconnected",
  RECONNECTING = "sidecar:reconnecting",
  FAILED = "sidecar:failed",
}

/**
 * Sidecar process manager with integrated IPC heartbeat.
 *
 * Manages the lifecycle of a sidecar process (start, stop, health check)
 * and monitors the IPC connection using IpcHeartbeat for automatic
 * reconnection on failure.
 */
export class SidecarManager extends EventEmitter {
  private readonly _config: SidecarConfig;
  private _state: SidecarState;
  private _pid: number | null;
  private _heartbeat: IpcHeartbeat | null;

  /**
   * @param config - Sidecar configuration.
   */
  constructor(config: SidecarConfig) {
    super();
    this._config = { ...DEFAULT_SIDECAR_CONFIG, ...config };
    this._state = SidecarState.STOPPED;
    this._pid = null;
    this._heartbeat = null;

    this.setMaxListeners(20);
  }

  /**
   * Get the current sidecar state.
   */
  getState(): SidecarState {
    return this._state;
  }

  /**
   * Get the sidecar process PID (if running).
   */
  getPid(): number | null {
    return this._pid;
  }

  /**
   * Get the sidecar configuration.
   */
  getConfig(): Readonly<SidecarConfig> {
    return this._config;
  }

  /**
   * Start the sidecar process and initialize IPC heartbeat.
   *
   * @param pingFn - Function to ping the sidecar for heartbeat.
   *   Should throw or reject on failure.
   * @returns The process PID on success.
   */
  async start(pingFn: () => Promise<void>): Promise<number> {
    if (this._state === SidecarState.RUNNING) {
      console.warn(
        `${LOG_PREFIX} ${this._config.name} is already running.`,
      );
      return this._pid!;
    }

    this._state = SidecarState.STARTING;
    console.info(
      `${LOG_PREFIX} Starting ${this._config.name}: ${this._config.executablePath}`,
    );

    try {
      // Note: In a real Electron app, process spawning would use child_process.spawn
      // For now, we mock the PID since we don't have the actual executable
      const normalizedPath: string = PathUtils.normalize(
        this._config.executablePath,
      );

      this._pid = this._generatePid();
      this._state = SidecarState.RUNNING;

      console.info(
        `${LOG_PREFIX} ${this._config.name} started (PID: ${this._pid})`,
      );

      // Initialize IPC heartbeat
      this._initHeartbeat(pingFn);

      // Start heartbeat
      if (this._heartbeat) {
        this._heartbeat.start();
      }

      this.emit(SidecarEvent.STARTED, {
        name: this._config.name,
        pid: this._pid,
      });

      return this._pid;
    } catch (err) {
      this._state = SidecarState.ERROR;
      this.emit(SidecarEvent.ERROR, {
        name: this._config.name,
        error: err,
      });

      throw err;
    }
  }

  /**
   * Stop the sidecar process and clean up heartbeat.
   */
  async stop(): Promise<void> {
    if (this._state === SidecarState.STOPPED) {
      return;
    }

    this._state = SidecarState.STOPPING;
    console.info(`${LOG_PREFIX} Stopping ${this._config.name}...`);

    if (this._heartbeat) {
      this._heartbeat.stop();
      this._heartbeat.removeAllListeners();
      this._heartbeat = null;
    }

    // In real implementation: kill the process
    this._pid = null;
    this._state = SidecarState.STOPPED;

    this.emit(SidecarEvent.STOPPED, {
      name: this._config.name,
    });

    console.info(`${LOG_PREFIX} ${this._config.name} stopped.`);
  }

  /**
   * Get the IPC heartbeat instance (for external monitoring).
   */
  getHeartbeat(): IpcHeartbeat | null {
    return this._heartbeat;
  }

  /**
   * Dispose of the sidecar manager and its IPC heartbeat.
   *
   * Stops the sidecar process if running, disposes the IPC heartbeat
   * (clears all timers + EventEmitter listeners), and resets state.
   * After calling this, the instance should not be reused.
   */
  async dispose(): Promise<void> {
    console.info(`${LOG_PREFIX} Disposing ${this._config.name} sidecar...`);

    // Stop the sidecar if running
    if (this._state !== SidecarState.STOPPED) {
      await this.stop();
    }

    // Dispose heartbeat if still present
    if (this._heartbeat) {
      this._heartbeat.dispose();
      this._heartbeat = null;
    }

    // Remove all sidecar EventEmitter listeners
    this.removeAllListeners();

    console.info(`${LOG_PREFIX} ${this._config.name} sidecar disposed.`);
  }

  // ================================================================
  // Private
  // ================================================================

  /** Initialize the IPC heartbeat monitor for this sidecar. */
  private _initHeartbeat(pingFn: () => Promise<void>): void {
    // Create liveness probe function that hits the health URL
    const livenessProbeFn = async (): Promise<boolean> => {
      try {
        const response = await fetch(this._config.healthUrl, {
          method: "GET",
          signal: AbortSignal.timeout(5_000),
        });
        return response.ok;
      } catch {
        return false;
      }
    };

    this._heartbeat = new IpcHeartbeat(
      pingFn,
      livenessProbeFn,
      this._config.heartbeatConfig ?? {},
    );

    // Forward heartbeat events to sidecar events
    this._heartbeat.on("connected", () => {
      this.emit(SidecarEvent.CONNECTED, {
        name: this._config.name,
      });
    });

    this._heartbeat.on("disconnected", () => {
      this.emit(SidecarEvent.DISCONNECTED, {
        name: this._config.name,
      });
    });

    this._heartbeat.on("reconnecting", (retryCount: number, maxRetries: number) => {
      this.emit(SidecarEvent.RECONNECTING, {
        name: this._config.name,
        retryCount,
        maxRetries,
      });
    });

    this._heartbeat.on("failed", (retryCount: number) => {
      this.emit(SidecarEvent.FAILED, {
        name: this._config.name,
        retryCount,
      });
    });

    console.info(
      `${LOG_PREFIX} IPC heartbeat initialized for ${this._config.name}.`,
    );
  }

  /** Generate a mock PID (for testing/demo). */
  private _generatePid(): number {
    return Math.floor(Math.random() * 60000) + 1000;
  }
}

export default SidecarManager;
