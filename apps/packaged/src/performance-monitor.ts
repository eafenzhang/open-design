/**
 * Open Design — Performance Monitor
 *
 * Main-process performance aggregator that:
 * 1. Collects FPS snapshots reported from the renderer via IPC
 * 2. Monitors event loop lag using process.hrtime()差值法
 * 3. Computes statistical buckets (avg/min/max/p99) for FPS data
 * 4. Checks performance thresholds and emits PerfWarning events
 * 5. Supports full cleanup via dispose()
 *
 * @module performance-monitor
 */

import { EventEmitter } from "node:events";
import {
  PERF_CONSTANTS,
  PERF_IPC_CHANNELS,
} from "./types/performance-metrics.js";
import type {
  PerformanceSnapshot,
  FpsBucket,
  EventLoopSample,
  PerfWarning,
} from "./types/performance-metrics.js";

/** Log prefix for this module. */
const LOG_PREFIX = "[OpenDesign:PerformanceMonitor]";

/** Callback type for IPC handler registration. */
export type IpcHandlerFn = (
  channel: string,
  handler: (...args: unknown[]) => unknown,
) => void;

/** Callback type for sending events to the renderer. */
export type IpcSendFn = (
  channel: string,
  ...args: unknown[]
) => void;

/**
 * Performance monitor for the main process.
 *
 * Aggregates renderer-reported FPS data, independently measures
 * event loop lag, and emits warnings when performance degrades
 * below configured thresholds.
 */
export class PerformanceMonitor extends EventEmitter {
  /** Rolling window of FPS samples (newest last). */
  private readonly _fpsSamples: number[];

  /** Rolling window of event loop lag samples. */
  private readonly _eventLoopSamples: EventLoopSample[];

  /** Latest full performance snapshot. */
  private _latestSnapshot: PerformanceSnapshot | null;

  /** Timestamp when FPS first dropped below threshold (for duration tracking). */
  private _fpsLowSince: number | null;

  /** Handle for the event loop monitor interval. */
  private _eventLoopTimer: ReturnType<typeof setInterval> | null;

  /** Whether the monitor is actively running. */
  private _isRunning: boolean;

  /** Total number of FPS snapshots received. */
  private _totalFpsSnapshots: number;

  /** Total number of event loop samples collected. */
  private _totalEventLoopSamples: number;

  /** Accumulated total for averaging. */
  private _fpsSum: number;

  /** Accumulated total for averaging. */
  private _lagSum: number;

  /** IPC handler registration function (injected). */
  private readonly _registerIpcHandler: IpcHandlerFn | null;

  /** IPC send function (injected). */
  private readonly _sendIpc: IpcSendFn | null;

  /**
   * @param registerIpcHandler - Optional function to register IPC handlers.
   *   When provided, the monitor will auto-register for FPS/memory snapshots.
   * @param sendIpc - Optional function to send IPC events to the renderer.
   *   When provided, perf warnings will be pushed to the renderer.
   */
  constructor(
    registerIpcHandler?: IpcHandlerFn,
    sendIpc?: IpcSendFn,
  ) {
    super();

    this._fpsSamples = [];
    this._eventLoopSamples = [];
    this._latestSnapshot = null;
    this._fpsLowSince = null;
    this._eventLoopTimer = null;
    this._isRunning = false;
    this._totalFpsSnapshots = 0;
    this._totalEventLoopSamples = 0;
    this._fpsSum = 0;
    this._lagSum = 0;
    this._registerIpcHandler = registerIpcHandler ?? null;
    this._sendIpc = sendIpc ?? null;

    // Auto-register IPC handlers if functions are provided
    if (this._registerIpcHandler) {
      this._registerIpcHandlers();
    }

    this.setMaxListeners(20);
  }

  // ================================================================
  // Public: Lifecycle
  // ================================================================

  /**
   * Start the FPS collection subsystem.
   *
   * Registers an IPC handler to receive FPS snapshots from the renderer.
   * The renderer is expected to send snapshots via `perf:fps-snapshot`
   * every 1 second using a requestAnimationFrame counter.
   */
  startFpsCollection(): void {
    console.info(
      `${LOG_PREFIX} FPS collection started (interval: ${PERF_CONSTANTS.FPS_COLLECTION_INTERVAL_MS}ms)`,
    );
    // IPC handler for FPS snapshots is registered in constructor
    // if registerIpcHandler was provided. Renderer sends data,
    // we just process it in recordFpsSnapshot().
  }

  /**
   * Start the event loop lag monitor.
   *
   * Uses process.hrtime()差值法 to measure blocking time on the
   * main thread. Samples every 2 seconds. The monitor schedules
   * a tight setTimeout and measures the actual delta vs expected
   * to approximate event loop lag.
   */
  startEventLoopMonitor(): void {
    if (this._isRunning) {
      console.warn(`${LOG_PREFIX} Event loop monitor already running.`);
      return;
    }

    this._isRunning = true;

    console.info(
      `${LOG_PREFIX} Event loop monitor started ` +
        `(interval: ${PERF_CONSTANTS.EVENT_LOOP_SAMPLE_INTERVAL_MS}ms)`,
    );

    this._scheduleEventLoopSample();
  }

  /**
   * Record an FPS snapshot received from the renderer.
   *
   * @param snapshot - The FPS snapshot from the renderer.
   */
  recordFpsSnapshot(snapshot: PerformanceSnapshot): void {
    this._fpsSamples.push(snapshot.fps);

    // Enforce max sample window
    if (this._fpsSamples.length > PERF_CONSTANTS.MAX_FPS_SAMPLES) {
      const removed: number = this._fpsSamples.shift()!;
      this._fpsSum -= removed;
    }

    this._fpsSum += snapshot.fps;
    this._totalFpsSnapshots++;
    this._latestSnapshot = { ...snapshot };

    // Check thresholds
    this._checkFpsThreshold(snapshot.fps);
  }

  /**
   * Record a main-process event loop lag sample.
   *
   * @param sample - The event loop sample.
   */
  recordEventLoopSample(sample: EventLoopSample): void {
    this._eventLoopSamples.push(sample);

    if (this._eventLoopSamples.length > PERF_CONSTANTS.MAX_EVENT_LOOP_SAMPLES) {
      this._eventLoopSamples.shift();
    }

    this._lagSum += sample.lagMs;
    this._totalEventLoopSamples++;

    // Update latest snapshot with current lag
    if (this._latestSnapshot) {
      this._latestSnapshot.eventLoopLagMs = sample.lagMs;
    }

    // Check thresholds
    this._checkEventLoopThreshold(sample.lagMs);
  }

  /**
   * Compute statistical bucket for FPS samples.
   *
   * @returns FpsBucket with avg/min/max/p99, or null if no samples.
   */
  bucketStats(): FpsBucket | null {
    if (this._fpsSamples.length === 0) {
      return null;
    }

    // Sort a copy for percentile calculation
    const sorted: number[] = [...this._fpsSamples].sort((a, b) => a - b);
    const count: number = sorted.length;
    const min: number = sorted[0];
    const max: number = sorted[count - 1];
    const avg: number = this._fpsSum / count;

    // P99: index = ceil(0.99 * count) - 1
    const p99Index: number = Math.ceil(0.99 * count) - 1;
    const p99: number = sorted[Math.max(0, Math.min(p99Index, count - 1))];

    return {
      avg: Math.round(avg * 100) / 100,
      min,
      max,
      p99,
      sampleCount: count,
      windowMs: count * PERF_CONSTANTS.FPS_COLLECTION_INTERVAL_MS,
    };
  }

  /**
   * Check performance thresholds and emit warnings if breached.
   *
   * Checks:
   * - FPS below 24 sustained for > 5 seconds → PerfWarning
   * - Event loop lag > 50ms → PerfWarning
   *
   * @returns The FPS bucket stats for external use.
   */
  checkThresholds(): FpsBucket | null {
    const bucket: FpsBucket | null = this.bucketStats();

    if (bucket && bucket.avg < PERF_CONSTANTS.FPS_WARNING_THRESHOLD) {
      this._emitPerfWarning({
        level: "critical",
        message: `FPS dropped below threshold: avg=${bucket.avg.toFixed(1)}, ` +
          `p99=${bucket.p99.toFixed(1)}, threshold=${PERF_CONSTANTS.FPS_WARNING_THRESHOLD}`,
        metric: "fps",
        currentValue: bucket.avg,
        threshold: PERF_CONSTANTS.FPS_WARNING_THRESHOLD,
        timestamp: new Date().toISOString(),
        contextSnapshot: this._latestSnapshot ?? undefined,
      });
    }

    return bucket;
  }

  /**
   * Dispose of the performance monitor.
   *
   * Clears all timers, removes all EventEmitter listeners,
   * and resets internal state.
   */
  dispose(): void {
    console.info(`${LOG_PREFIX} Disposing performance monitor...`);

    this._isRunning = false;

    // Clear event loop timer
    if (this._eventLoopTimer) {
      clearTimeout(this._eventLoopTimer);
      this._eventLoopTimer = null;
    }

    // Reset state
    this._fpsSamples.length = 0;
    this._eventLoopSamples.length = 0;
    this._latestSnapshot = null;
    this._fpsLowSince = null;
    this._fpsSum = 0;
    this._lagSum = 0;

    // Remove all listeners
    this.removeAllListeners();

    console.info(`${LOG_PREFIX} Performance monitor disposed.`);
  }

  // ================================================================
  // Public: Getters
  // ================================================================

  /**
   * Get the latest full performance snapshot.
   */
  getLatestSnapshot(): PerformanceSnapshot | null {
    return this._latestSnapshot;
  }

  /**
   * Get the rolling window of FPS samples.
   */
  getFpsSamples(): readonly number[] {
    return this._fpsSamples;
  }

  /**
   * Get the rolling window of event loop samples.
   */
  getEventLoopSamples(): readonly EventLoopSample[] {
    return this._eventLoopSamples;
  }

  /**
   * Check if the monitor is actively running.
   */
  isRunning(): boolean {
    return this._isRunning;
  }

  /**
   * Get the total number of FPS snapshots collected.
   */
  getTotalFpsSnapshots(): number {
    return this._totalFpsSnapshots;
  }

  // ================================================================
  // Private: IPC Registration
  // ================================================================

  /** Register IPC handlers for renderer → main communication. */
  private _registerIpcHandlers(): void {
    if (!this._registerIpcHandler) {
      return;
    }

    // Handle FPS snapshot from renderer
    this._registerIpcHandler(
      PERF_IPC_CHANNELS.FPS_SNAPSHOT,
      (_event: unknown, snapshot: PerformanceSnapshot) => {
        this.recordFpsSnapshot(snapshot);
      },
    );

    // Handle memory snapshot from renderer
    this._registerIpcHandler(
      PERF_IPC_CHANNELS.MEMORY_SNAPSHOT,
      (_event: unknown, memoryMB: number) => {
        if (this._latestSnapshot) {
          this._latestSnapshot.memoryMB = memoryMB;
        }
      },
    );

    // Handle stats request
    this._registerIpcHandler(
      PERF_IPC_CHANNELS.PERF_STATS,
      () => {
        const latestLag: number =
          this._eventLoopSamples.length > 0
            ? this._eventLoopSamples[this._eventLoopSamples.length - 1].lagMs
            : 0;
        return latestLag;
      },
    );
  }

  // ================================================================
  // Private: Event Loop Sampling
  // ================================================================

  /**
   * Schedule a single event loop lag measurement.
   *
   * Uses the process.hrtime()差值法: schedules a setTimeout(0),
   * measures the actual time between scheduling and execution,
   * and computes the difference as estimated event loop lag.
   */
  private _scheduleEventLoopSample(): void {
    if (!this._isRunning) {
      return;
    }

    // Schedule next sample
    this._eventLoopTimer = setTimeout(() => {
      this._measureEventLoopLag();
      this._scheduleEventLoopSample();
    }, PERF_CONSTANTS.EVENT_LOOP_SAMPLE_INTERVAL_MS);

    this._eventLoopTimer.unref();
  }

  /** Perform a single event loop lag measurement using hrtime. */
  private _measureEventLoopLag(): void {
    const start: [number, number] = process.hrtime();

    // Schedule an immediate callback to measure the delta
    setImmediate(() => {
      const diff: [number, number] = process.hrtime(start);
      const lagMs: number = diff[0] * 1000 + diff[1] / 1_000_000;

      const sample: EventLoopSample = {
        lagMs: Math.round(lagMs * 100) / 100,
        timestamp: new Date().toISOString(),
      };

      this.recordEventLoopSample(sample);
    });
  }

  // ================================================================
  // Private: Threshold Checks
  // ================================================================

  /**
   * Check if FPS has dropped below the warning threshold.
   * Tracks consecutive low-FPS duration; emits warning if sustained > 5s.
   */
  private _checkFpsThreshold(fps: number): void {
    if (fps < PERF_CONSTANTS.FPS_WARNING_THRESHOLD) {
      if (this._fpsLowSince === null) {
        this._fpsLowSince = Date.now();
      }

      const lowDuration: number = Date.now() - this._fpsLowSince;
      if (lowDuration >= PERF_CONSTANTS.FPS_WARNING_DURATION_MS) {
        this._emitPerfWarning({
          level: "warning",
          message: `Low FPS sustained for ${(lowDuration / 1000).toFixed(1)}s: ` +
            `current=${fps}, threshold=${PERF_CONSTANTS.FPS_WARNING_THRESHOLD}`,
          metric: "fps",
          currentValue: fps,
          threshold: PERF_CONSTANTS.FPS_WARNING_THRESHOLD,
          timestamp: new Date().toISOString(),
          contextSnapshot: this._latestSnapshot ?? undefined,
        });

        // Reset to avoid repeated warnings for the same episode
        this._fpsLowSince = null;
      }
    } else {
      // FPS recovered
      this._fpsLowSince = null;
    }
  }

  /**
   * Check if event loop lag exceeds the warning threshold.
   */
  private _checkEventLoopThreshold(lagMs: number): void {
    if (lagMs > PERF_CONSTANTS.EVENT_LOOP_LAG_WARNING_THRESHOLD_MS) {
      this._emitPerfWarning({
        level: "warning",
        message: `High event loop lag detected: ${lagMs.toFixed(1)}ms > ` +
          `${PERF_CONSTANTS.EVENT_LOOP_LAG_WARNING_THRESHOLD_MS}ms threshold`,
        metric: "eventLoopLag",
        currentValue: lagMs,
        threshold: PERF_CONSTANTS.EVENT_LOOP_LAG_WARNING_THRESHOLD_MS,
        timestamp: new Date().toISOString(),
        contextSnapshot: this._latestSnapshot ?? undefined,
      });
    }
  }

  /**
   * Emit a performance warning — both locally via EventEmitter
   * and to the renderer via IPC if configured.
   */
  private _emitPerfWarning(warning: PerfWarning): void {
    console.warn(
      `${LOG_PREFIX} [${warning.level.toUpperCase()}] ${warning.message}`,
    );

    // Emit locally
    this.emit("perf:warning", warning);

    // Push to renderer if IPC send is configured
    if (this._sendIpc) {
      try {
        this._sendIpc(PERF_IPC_CHANNELS.PERF_WARNING, warning);
      } catch (err) {
        console.error(
          `${LOG_PREFIX} Failed to send perf warning to renderer:`,
          err,
        );
      }
    }
  }
}

export default PerformanceMonitor;
