/**
 * Open Design — Performance Metrics Types
 *
 * Defines the type system for performance monitoring including
 * FPS tracking, event loop lag sampling, memory snapshots,
 * and performance warning interfaces.
 *
 * @module types/performance-metrics
 */

/** Window state enumeration for title bar UI. */
export enum WindowState {
  NORMAL = "normal",
  MAXIMIZED = "maximized",
  MINIMIZED = "minimized",
  FULLSCREEN = "fullscreen",
}

/**
 * A single snapshot of performance metrics collected from the renderer.
 * Sent via IPC from the renderer process to the main process.
 */
export interface PerformanceSnapshot {
  /** Current frames-per-second measurement. */
  fps: number;

  /** ISO 8601 UTC timestamp of the snapshot. */
  timestamp: string;

  /** Event loop lag in milliseconds (measured on main process). */
  eventLoopLagMs: number;

  /** Memory usage in megabytes (from performance.memory in renderer). */
  memoryMB: number;
}

/**
 * Statistical bucket for FPS metrics over a collection window.
 */
export interface FpsBucket {
  /** Average FPS over the collection window. */
  avg: number;

  /** Minimum FPS observed. */
  min: number;

  /** Maximum FPS observed. */
  max: number;

  /** 99th percentile FPS (P99). */
  p99: number;

  /** Total number of samples in the bucket. */
  sampleCount: number;

  /** Duration of the collection window in milliseconds. */
  windowMs: number;
}

/**
 * A single sample of main-process event loop lag.
 * Collected every 2 seconds via process.hrtime()差值法.
 */
export interface EventLoopSample {
  /** Event loop lag in milliseconds. */
  lagMs: number;

  /** ISO 8601 UTC timestamp of the sample. */
  timestamp: string;
}

/**
 * Performance warning emitted when thresholds are breached.
 * Triggered when FPS drops below 24 for more than 5 consecutive seconds.
 */
export interface PerfWarning {
  /** Warning severity level. */
  level: "warning" | "critical";

  /** Human-readable warning message. */
  message: string;

  /** The metric that triggered the warning. */
  metric: string;

  /** Current value of the metric. */
  currentValue: number;

  /** Threshold that was breached. */
  threshold: number;

  /** ISO 8601 UTC timestamp of the warning. */
  timestamp: string;

  /** Optional context snapshot at the time of the warning. */
  contextSnapshot?: PerformanceSnapshot;
}

/** Performance monitor configuration constants. */
export const PERF_CONSTANTS = {
  /** FPS collection interval (renderer reports every 1s). */
  FPS_COLLECTION_INTERVAL_MS: 1_000,

  /** Event loop lag sampling interval (main process, every 2s). */
  EVENT_LOOP_SAMPLE_INTERVAL_MS: 2_000,

  /** Memory sampling interval (renderer reports every 30s). */
  MEMORY_SAMPLE_INTERVAL_MS: 30_000,

  /** FPS threshold for performance warnings. */
  FPS_WARNING_THRESHOLD: 24,

  /** Duration below FPS threshold before triggering warning (ms). */
  FPS_WARNING_DURATION_MS: 5_000,

  /** Event loop lag warning threshold (ms). */
  EVENT_LOOP_LAG_WARNING_THRESHOLD_MS: 50,

  /** Maximum number of FPS samples to retain in rolling window. */
  MAX_FPS_SAMPLES: 300,

  /** Maximum number of event loop samples to retain. */
  MAX_EVENT_LOOP_SAMPLES: 150,

  /** IPC compression threshold (bytes). Payloads > this are gzipped. */
  IPC_COMPRESSION_THRESHOLD_BYTES: 64 * 1024,
} as const;

/** IPC channel names for performance monitoring. */
export const PERF_IPC_CHANNELS = {
  /** Renderer → Main: FPS snapshot report. */
  FPS_SNAPSHOT: "perf:fps-snapshot",

  /** Renderer → Main: Memory usage report. */
  MEMORY_SNAPSHOT: "perf:memory-snapshot",

  /** Main → Renderer: Performance warning notification. */
  PERF_WARNING: "perf:warning",

  /** Renderer → Main: Request current performance stats. */
  PERF_STATS: "perf:stats",
} as const;

/** IPC channel names for window control. */
export const WINDOW_IPC_CHANNELS = {
  /** Renderer → Main: Minimize window. */
  MINIMIZE: "window:minimize",

  /** Renderer → Main: Maximize / restore window. */
  MAXIMIZE: "window:maximize",

  /** Renderer → Main: Close window. */
  CLOSE: "window:close",

  /** Renderer → Main: Query current maximize state. */
  IS_MAXIMIZED: "window:isMaximized",

  /** Renderer → Main: Show system (app) menu. */
  SYSTEM_MENU: "window:systemMenu",

  /** Main → Renderer: Maximize state change notification. */
  MAXIMIZE_CHANGE: "window:maximizeChange",
} as const;
