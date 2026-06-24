/**
 * Open Design — IPC Heartbeat
 *
 * Monitors sidecar IPC connections between daemon and renderer processes.
 * Implements heartbeat-based dead connection detection with exponential
 * backoff reconnection and liveness probing.
 *
 * EventBus emits: connected | disconnected | reconnecting | failed | state-change
 *
 * @module ipc-heartbeat
 */

import { EventEmitter } from "node:events";

import {
  IpcConnectionState,
  IpcHeartbeatEvent,
  type IpcReconnectConfig,
  DEFAULT_IPC_RECONNECT_CONFIG,
} from "./types/ipc-config.js";

/** Log prefix for this module. */
const LOG_PREFIX = "[OpenDesign:IpcHeartbeat]";

/**
 * Heartbeat monitor for daemon ↔ renderer sidecar IPC connections.
 *
 * Features:
 * - Heartbeat loop: PING every 5s, 15s timeout → DISCONNECTED
 * - Exponential backoff reconnection: 1s → 2s → 4s → 8s → 16s → 30s (cap)
 * - Liveness Probe: HTTP GET daemon /health before reconnecting
 * - EventEmitter for state change notifications
 * - Max retries before entering FAILED state
 */
export class IpcHeartbeat extends EventEmitter {
  /** Reconnection configuration. */
  private readonly _config: IpcReconnectConfig;

  /** Current connection state. */
  private _state: IpcConnectionState;

  /** Number of consecutive reconnection attempts. */
  private _retryCount: number;

  /** Handle for the heartbeat interval timer. */
  private _heartbeatTimer: ReturnType<typeof setInterval> | null;

  /** Handle for the heartbeat timeout timer. */
  private _heartbeatTimeoutTimer: ReturnType<typeof setTimeout> | null;

  /** Handle for the reconnection delay timer. */
  private _reconnectTimer: ReturnType<typeof setTimeout> | null;

  /** Whether the heartbeat monitor is actively running. */
  private _isRunning: boolean;

  /**
   * Callback to perform the actual PING operation.
   * Called by the heartbeat loop; should throw on failure.
   */
  private readonly _pingFn: () => Promise<void>;

  /**
   * Callback to perform the liveness probe.
   * Called before reconnection; should return true if daemon is alive.
   */
  private readonly _livenessProbeFn: () => Promise<boolean>;

  /**
   * @param pingFn - Function to call for heartbeat PING.
   *   Should throw or reject if the connection is dead.
   * @param livenessProbeFn - Function to call for liveness probe.
   *   Should return true if daemon is reachable.
   * @param config - Optional reconnect configuration override.
   */
  constructor(
    pingFn: () => Promise<void>,
    livenessProbeFn: () => Promise<boolean>,
    config: Partial<IpcReconnectConfig> = {},
  ) {
    super();

    this._config = { ...DEFAULT_IPC_RECONNECT_CONFIG, ...config };
    this._state = IpcConnectionState.DISCONNECTED;
    this._retryCount = 0;
    this._heartbeatTimer = null;
    this._heartbeatTimeoutTimer = null;
    this._reconnectTimer = null;
    this._isRunning = false;
    this._pingFn = pingFn;
    this._livenessProbeFn = livenessProbeFn;

    this.setMaxListeners(20);
  }

  /**
   * Start the heartbeat monitor.
   *
   * Performs an initial liveness probe, then enters the heartbeat loop.
   * Must be called after daemon is confirmed running.
   */
  start(): void {
    if (this._isRunning) {
      console.warn(`${LOG_PREFIX} Heartbeat already running.`);
      return;
    }

    this._isRunning = true;
    console.info(`${LOG_PREFIX} Starting heartbeat monitor...`);

    // Perform initial liveness probe, then start heartbeat loop
    this._initialConnect();
  }

  /**
   * Stop the heartbeat monitor and clean up all timers.
   */
  stop(): void {
    console.info(`${LOG_PREFIX} Stopping heartbeat monitor.`);
    this._isRunning = false;
    this._clearAllTimers();
    this._transitionTo(IpcConnectionState.DISCONNECTED);
  }

  /**
   * Get the current IPC connection state.
   */
  getState(): IpcConnectionState {
    return this._state;
  }

  /**
   * Get the current reconnection configuration.
   */
  getConfig(): Readonly<IpcReconnectConfig> {
    return this._config;
  }

  /**
   * Get the current retry count.
   */
  getRetryCount(): number {
    return this._retryCount;
  }

  /**
   * Dispose of the IPC heartbeat monitor.
   *
   * Stops all monitoring, clears all timers (interval + timeout +
   * reconnect), and removes all EventEmitter listeners. After calling
   * this, the instance should not be reused.
   */
  dispose(): void {
    console.info(`${LOG_PREFIX} Disposing IPC heartbeat monitor...`);

    // Stop the heartbeat loop and clear timers
    this._isRunning = false;
    this._clearAllTimers();

    // Reset state
    this._state = IpcConnectionState.DISCONNECTED;
    this._retryCount = 0;

    // Remove all EventEmitter listeners to prevent memory leaks
    this.removeAllListeners();

    console.info(`${LOG_PREFIX} IPC heartbeat disposed.`);
  }

  /**
   * Check if the heartbeat monitor is running.
   */
  isRunning(): boolean {
    return this._isRunning;
  }

  /**
   * Register a callback for state changes.
   *
   * @param callback - Called with (newState, oldState) on every state transition.
   */
  onStateChange(
    callback: (newState: IpcConnectionState, oldState: IpcConnectionState) => void,
  ): void {
    this.on(IpcHeartbeatEvent.STATE_CHANGE, callback);
  }

  // ================================================================
  // Private: Heartbeat Logic
  // ================================================================

  /** Initial connection attempt after start(). */
  private async _initialConnect(): Promise<void> {
    try {
      const alive: boolean = await this._livenessProbeFn();
      if (alive) {
        this._transitionTo(IpcConnectionState.CONNECTED);
        this._startHeartbeatLoop();
      } else {
        console.warn(
          `${LOG_PREFIX} Daemon not reachable on initial probe. Starting reconnect.`,
        );
        this._scheduleReconnect();
      }
    } catch (err) {
      console.warn(
        `${LOG_PREFIX} Initial liveness probe failed:`,
        err instanceof Error ? err.message : err,
      );
      this._scheduleReconnect();
    }
  }

  /** Start the periodic heartbeat loop. */
  private _startHeartbeatLoop(): void {
    this._clearHeartbeatTimers();

    this._heartbeatTimer = setInterval(() => {
      this._ping().catch((err: unknown) => {
        console.warn(
          `${LOG_PREFIX} Heartbeat PING failed:`,
          err instanceof Error ? err.message : err,
        );
      });
    }, this._config.heartbeatIntervalMs);

    // Unref to avoid keeping the process alive during tests
    this._heartbeatTimer.unref();

    console.info(
      `${LOG_PREFIX} Heartbeat loop started (interval: ${this._config.heartbeatIntervalMs}ms).`,
    );
  }

  /** Perform a single PING operation with a timeout. */
  private async _ping(): Promise<void> {
    if (!this._isRunning || this._state !== IpcConnectionState.CONNECTED) {
      return;
    }

    try {
      // Set up timeout race
      const timeoutPromise: Promise<never> = new Promise((_, reject) => {
        this._heartbeatTimeoutTimer = setTimeout(() => {
          reject(
            new Error(
              `Heartbeat timeout after ${this._config.heartbeatTimeoutMs}ms`,
            ),
          );
        }, this._config.heartbeatTimeoutMs);
        this._heartbeatTimeoutTimer.unref();
      });

      await Promise.race([this._pingFn(), timeoutPromise]);

      // Success: clear the timeout
      if (this._heartbeatTimeoutTimer) {
        clearTimeout(this._heartbeatTimeoutTimer);
        this._heartbeatTimeoutTimer = null;
      }
    } catch (err) {
      // PING failed → connection lost
      if (this._heartbeatTimeoutTimer) {
        clearTimeout(this._heartbeatTimeoutTimer);
        this._heartbeatTimeoutTimer = null;
      }

      console.warn(
        `${LOG_PREFIX} Heartbeat PING failed, connection lost:`,
        err instanceof Error ? err.message : err,
      );

      this._onConnectionLost();
    }
  }

  /** Handle connection loss: stop heartbeat, start reconnecting. */
  private _onConnectionLost(): void {
    if (this._state === IpcConnectionState.DISCONNECTED) {
      return; // Already disconnected
    }

    this._clearHeartbeatTimers();
    this._transitionTo(IpcConnectionState.DISCONNECTED);
    this._scheduleReconnect();
  }

  // ================================================================
  // Private: Reconnection Logic
  // ================================================================

  /** Schedule a reconnection attempt with exponential backoff. */
  private _scheduleReconnect(): void {
    if (!this._isRunning) {
      return;
    }

    if (this._state === IpcConnectionState.FAILED) {
      console.warn(
        `${LOG_PREFIX} Already in FAILED state. Not scheduling reconnect.`,
      );
      return;
    }

    this._transitionTo(IpcConnectionState.RECONNECTING);

    const delay: number = this._calculateBackoffDelay();

    console.info(
      `${LOG_PREFIX} Scheduling reconnect attempt ${this._retryCount + 1}/${this._config.maxRetries} in ${delay}ms`,
    );

    this._reconnectTimer = setTimeout(() => {
      this._attemptReconnect().catch((err: unknown) => {
        console.error(
          `${LOG_PREFIX} Reconnect attempt failed:`,
          err instanceof Error ? err.message : err,
        );
      });
    }, delay);

    this._reconnectTimer.unref();
  }

  /** Calculate the exponential backoff delay for the current retry count. */
  private _calculateBackoffDelay(): number {
    // Exponential: initialDelayMs * 2^retryCount, capped at maxDelayMs
    const exponential: number =
      this._config.initialDelayMs * Math.pow(2, this._retryCount);
    return Math.min(exponential, this._config.maxDelayMs);
  }

  /** Attempt to reconnect to the daemon. */
  private async _attemptReconnect(): Promise<void> {
    if (!this._isRunning) {
      return;
    }

    this._retryCount++;

    try {
      const alive: boolean = await this._livenessProbeFn();

      if (alive) {
        // Daemon is alive → try to re-establish connection
        await this._pingFn();
        this._onReconnectSuccess();
      } else {
        // Daemon not alive → schedule next retry or fail
        this._onReconnectFailure(
          new Error("Daemon not reachable on liveness probe"),
        );
      }
    } catch (err) {
      this._onReconnectFailure(
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  /** Handle successful reconnection. */
  private _onReconnectSuccess(): void {
    console.info(
      `${LOG_PREFIX} Reconnection successful after ${this._retryCount} attempts.`,
    );

    this._resetRetryCount();
    this._transitionTo(IpcConnectionState.CONNECTED);
    this._startHeartbeatLoop();
  }

  /** Handle failed reconnection attempt. */
  private _onReconnectFailure(err: Error): void {
    console.warn(
      `${LOG_PREFIX} Reconnect attempt ${this._retryCount}/${this._config.maxRetries} failed: ${err.message}`,
    );

    if (this._retryCount >= this._config.maxRetries) {
      console.error(
        `${LOG_PREFIX} Max retries (${this._config.maxRetries}) exceeded. Entering FAILED state.`,
      );
      this._transitionTo(IpcConnectionState.FAILED);
      this.emit(IpcHeartbeatEvent.FAILED, {
        retryCount: this._retryCount,
        lastError: err.message,
      });
    } else {
      this._scheduleReconnect();
    }
  }

  /** Reset the retry counter (called on successful connection). */
  private _resetRetryCount(): void {
    this._retryCount = 0;
  }

  // ================================================================
  // Private: State Management
  // ================================================================

  /** Transition to a new state and emit events. */
  private _transitionTo(newState: IpcConnectionState): void {
    if (this._state === newState) {
      return;
    }

    const oldState: IpcConnectionState = this._state;
    this._state = newState;

    const timestamp: string = new Date().toISOString();

    console.info(
      `${LOG_PREFIX} State transition: ${oldState} → ${newState} [${timestamp}]`,
    );

    // Emit generic state change
    this.emit(IpcHeartbeatEvent.STATE_CHANGE, newState, oldState, timestamp);

    // Emit specific event
    switch (newState) {
      case IpcConnectionState.CONNECTED:
        this.emit(IpcHeartbeatEvent.CONNECTED, timestamp);
        break;
      case IpcConnectionState.DISCONNECTED:
        this.emit(IpcHeartbeatEvent.DISCONNECTED, timestamp);
        break;
      case IpcConnectionState.RECONNECTING:
        this.emit(
          IpcHeartbeatEvent.RECONNECTING,
          this._retryCount,
          this._config.maxRetries,
          timestamp,
        );
        break;
      case IpcConnectionState.FAILED:
        this.emit(
          IpcHeartbeatEvent.FAILED,
          this._retryCount,
          timestamp,
        );
        break;
    }
  }

  // ================================================================
  // Private: Timer Management
  // ================================================================

  /** Clear all active timers. */
  private _clearAllTimers(): void {
    this._clearHeartbeatTimers();

    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  /** Clear heartbeat-specific timers. */
  private _clearHeartbeatTimers(): void {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }

    if (this._heartbeatTimeoutTimer) {
      clearTimeout(this._heartbeatTimeoutTimer);
      this._heartbeatTimeoutTimer = null;
    }
  }
}

export default IpcHeartbeat;
