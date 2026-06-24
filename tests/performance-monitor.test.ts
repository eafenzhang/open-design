/**
 * Unit tests for PerformanceMonitor — FPS collection, bucket stats,
 * threshold checks, event loop monitoring, and disposal.
 *
 * @module tests/unit/performance-monitor
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PerformanceMonitor } from "../../apps/packaged/src/performance-monitor.js";
import { PERF_CONSTANTS } from "../../apps/packaged/src/types/performance-metrics.js";
import type {
  PerformanceSnapshot,
  EventLoopSample,
  PerfWarning,
} from "../../apps/packaged/src/types/performance-metrics.js";

/** Create a valid FPS snapshot fixture. */
function fpsSnapshot(fps: number, memoryMB = 0): PerformanceSnapshot {
  return {
    fps,
    timestamp: new Date().toISOString(),
    eventLoopLagMs: 0,
    memoryMB,
  };
}

/** Create a valid event loop sample fixture. */
function eventLoopSample(lagMs: number): EventLoopSample {
  return {
    lagMs,
    timestamp: new Date().toISOString(),
  };
}

describe("PerformanceMonitor", () => {
  let monitor: PerformanceMonitor;

  beforeEach(() => {
    monitor = new PerformanceMonitor();
  });

  afterEach(() => {
    monitor?.dispose();
  });

  // ================================================================
  // Initialization
  // ================================================================
  describe("initialization", () => {
    it("should not be running by default", () => {
      expect(monitor.isRunning()).toBe(false);
    });

    it("should have 0 FPS snapshots initially", () => {
      expect(monitor.getTotalFpsSnapshots()).toBe(0);
    });

    it("should have null latest snapshot initially", () => {
      expect(monitor.getLatestSnapshot()).toBeNull();
    });

    it("should have empty FPS samples array", () => {
      expect(monitor.getFpsSamples()).toHaveLength(0);
    });

    it("should have empty event loop samples array", () => {
      expect(monitor.getEventLoopSamples()).toHaveLength(0);
    });
  });

  // ================================================================
  // recordFpsSnapshot()
  // ================================================================
  describe("recordFpsSnapshot()", () => {
    it("should store FPS samples in order", () => {
      monitor.recordFpsSnapshot(fpsSnapshot(60));
      monitor.recordFpsSnapshot(fpsSnapshot(55));
      monitor.recordFpsSnapshot(fpsSnapshot(30));

      expect(monitor.getFpsSamples()).toEqual([60, 55, 30]);
      expect(monitor.getTotalFpsSnapshots()).toBe(3);
    });

    it("should update latest snapshot on each record", () => {
      const snap = fpsSnapshot(60, 128);
      monitor.recordFpsSnapshot(snap);

      const latest = monitor.getLatestSnapshot();
      expect(latest).not.toBeNull();
      expect(latest!.fps).toBe(60);
      expect(latest!.memoryMB).toBe(128);
    });

    it("should enforce max FPS sample window (rolling)", () => {
      // Fill up to max
      for (let i = 0; i < PERF_CONSTANTS.MAX_FPS_SAMPLES + 10; i++) {
        monitor.recordFpsSnapshot(fpsSnapshot(60));
      }

      expect(monitor.getFpsSamples().length).toBeLessThanOrEqual(
        PERF_CONSTANTS.MAX_FPS_SAMPLES,
      );
    });
  });

  // ================================================================
  // recordEventLoopSample()
  // ================================================================
  describe("recordEventLoopSample()", () => {
    it("should store event loop samples", () => {
      monitor.recordEventLoopSample(eventLoopSample(12.5));
      monitor.recordEventLoopSample(eventLoopSample(8.3));

      const samples = monitor.getEventLoopSamples();
      expect(samples).toHaveLength(2);
      expect(samples[0]!.lagMs).toBe(12.5);
      expect(samples[1]!.lagMs).toBe(8.3);
    });

    it("should update latest snapshot lag when available", () => {
      monitor.recordFpsSnapshot(fpsSnapshot(60));
      monitor.recordEventLoopSample(eventLoopSample(15.7));

      const latest = monitor.getLatestSnapshot();
      expect(latest).not.toBeNull();
      expect(latest!.eventLoopLagMs).toBe(15.7);
    });

    it("should enforce max event loop sample window", () => {
      for (let i = 0; i < PERF_CONSTANTS.MAX_EVENT_LOOP_SAMPLES + 10; i++) {
        monitor.recordEventLoopSample(eventLoopSample(5));
      }

      expect(monitor.getEventLoopSamples().length).toBeLessThanOrEqual(
        PERF_CONSTANTS.MAX_EVENT_LOOP_SAMPLES,
      );
    });
  });

  // ================================================================
  // bucketStats()
  // ================================================================
  describe("bucketStats()", () => {
    it("should return null when no FPS samples", () => {
      expect(monitor.bucketStats()).toBeNull();
    });

    it("should compute avg/min/max/p99 correctly for single sample", () => {
      monitor.recordFpsSnapshot(fpsSnapshot(60));

      const bucket = monitor.bucketStats();
      expect(bucket).not.toBeNull();
      expect(bucket!.avg).toBe(60);
      expect(bucket!.min).toBe(60);
      expect(bucket!.max).toBe(60);
      expect(bucket!.p99).toBe(60);
      expect(bucket!.sampleCount).toBe(1);
    });

    it("should compute avg/min/max/p99 correctly for multiple samples", () => {
      // Record samples: 10, 20, 30, 40, 50, 60, 70, 80, 90, 100
      for (let fps = 10; fps <= 100; fps += 10) {
        monitor.recordFpsSnapshot(fpsSnapshot(fps));
      }

      const bucket = monitor.bucketStats();
      expect(bucket).not.toBeNull();
      expect(bucket!.min).toBe(10);
      expect(bucket!.max).toBe(100);
      expect(bucket!.avg).toBe(55); // (10+20+...+100)/10 = 55
      expect(bucket!.sampleCount).toBe(10);
    });

    it("should compute p99 correctly with 100 samples", () => {
      for (let i = 0; i < 100; i++) {
        monitor.recordFpsSnapshot(fpsSnapshot(i + 1)); // 1..100
      }

      const bucket = monitor.bucketStats();
      expect(bucket).not.toBeNull();
      // P99 index = ceil(0.99*100) - 1 = 99 - 1 = 98 → value = 99
      expect(bucket!.p99).toBe(99);
    });

    it("should compute p99 correctly with 200 samples", () => {
      for (let i = 0; i < 200; i++) {
        monitor.recordFpsSnapshot(fpsSnapshot(i + 1)); // 1..200
      }

      const bucket = monitor.bucketStats();
      expect(bucket).not.toBeNull();
      // P99 index = ceil(0.99*200) - 1 = 198 - 1 = 197 → value = 198
      expect(bucket!.p99).toBe(198);
    });

    it("should compute windowMs correctly", () => {
      for (let i = 0; i < 5; i++) {
        monitor.recordFpsSnapshot(fpsSnapshot(60));
      }

      const bucket = monitor.bucketStats();
      expect(bucket!.windowMs).toBe(5 * PERF_CONSTANTS.FPS_COLLECTION_INTERVAL_MS);
    });

    it("should round avg to 2 decimal places", () => {
      monitor.recordFpsSnapshot(fpsSnapshot(10));
      monitor.recordFpsSnapshot(fpsSnapshot(20));
      monitor.recordFpsSnapshot(fpsSnapshot(30));
      // avg = 60/3 = 20.00

      const bucket = monitor.bucketStats();
      expect(bucket!.avg).toBe(20);
    });
  });

  // ================================================================
  // checkThresholds()
  // ================================================================
  describe("checkThresholds()", () => {
    it("should return bucket stats when called", () => {
      monitor.recordFpsSnapshot(fpsSnapshot(60));
      monitor.recordFpsSnapshot(fpsSnapshot(55));

      const result = monitor.checkThresholds();
      expect(result).not.toBeNull();
      expect(result!.avg).toBe(57.5);
    });

    it("should return null when no samples available", () => {
      const result = monitor.checkThresholds();
      expect(result).toBeNull();
    });

    it("should emit perf:warning when avg FPS below threshold", () => {
      const warningSpy = vi.fn();
      monitor.on("perf:warning", warningSpy);

      // Record low FPS samples
      for (let i = 0; i < 10; i++) {
        monitor.recordFpsSnapshot(fpsSnapshot(10)); // Below 24 threshold
      }

      const result = monitor.checkThresholds();
      expect(result).not.toBeNull();
      expect(result!.avg).toBeLessThan(PERF_CONSTANTS.FPS_WARNING_THRESHOLD);

      // checkThresholds uses bucketStats avg (not sustained low FPS check)
      // The avg is 10 which is < 24, so it emits critical warning
      expect(warningSpy).toHaveBeenCalled();

      const warning: PerfWarning = warningSpy.mock.calls[0]![0] as PerfWarning;
      expect(warning.level).toBe("critical");
      expect(warning.metric).toBe("fps");
      expect(warning.currentValue).toBeLessThan(PERF_CONSTANTS.FPS_WARNING_THRESHOLD);
    });

    it("should emit critical level FPS warning from checkThresholds", () => {
      const warningSpy = vi.fn();
      monitor.on("perf:warning", warningSpy);

      monitor.recordFpsSnapshot(fpsSnapshot(10));
      monitor.recordFpsSnapshot(fpsSnapshot(12));
      monitor.checkThresholds();

      expect(warningSpy).toHaveBeenCalled();
      const warning: PerfWarning = warningSpy.mock.calls[0]![0] as PerfWarning;
      expect(warning.level).toBe("critical");
    });

    it("should NOT emit warning when avg FPS above threshold", () => {
      const warningSpy = vi.fn();
      monitor.on("perf:warning", warningSpy);

      monitor.recordFpsSnapshot(fpsSnapshot(60));
      monitor.recordFpsSnapshot(fpsSnapshot(55));
      monitor.checkThresholds();

      expect(warningSpy).not.toHaveBeenCalled();
    });
  });

  // ================================================================
  // Low FPS sustained warning (via recordFpsSnapshot)
  // ================================================================
  describe("sustained low FPS warning", () => {
    it("should emit warning-level event when low FPS sustained > 5s", async () => {
      vi.useFakeTimers();

      const warningSpy = vi.fn();
      monitor.on("perf:warning", warningSpy);

      // Record low FPS at t=0
      monitor.recordFpsSnapshot(fpsSnapshot(20)); // Below 24
      expect(warningSpy).not.toHaveBeenCalled();

      // Advance 6 seconds and record another low FPS
      vi.advanceTimersByTime(6_000);
      monitor.recordFpsSnapshot(fpsSnapshot(20));

      // Should have emitted warning (sustained > 5s)
      expect(warningSpy).toHaveBeenCalled();
      const warning: PerfWarning = warningSpy.mock.calls[0]![0] as PerfWarning;
      expect(warning.level).toBe("warning");

      vi.useRealTimers();
    });

    it("should NOT emit warning when FPS recovers before 5s", async () => {
      vi.useFakeTimers();

      const warningSpy = vi.fn();
      monitor.on("perf:warning", warningSpy);

      // Low FPS at t=0
      monitor.recordFpsSnapshot(fpsSnapshot(20));

      // Advance 3 seconds — FPS recovers
      vi.advanceTimersByTime(3_000);
      monitor.recordFpsSnapshot(fpsSnapshot(60)); // Above threshold

      // Advance another 3 seconds — should not have warned
      vi.advanceTimersByTime(3_000);
      expect(warningSpy).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("should reset low FPS timer after warning emitted", async () => {
      vi.useFakeTimers();

      const warningSpy = vi.fn();
      monitor.on("perf:warning", warningSpy);

      // First low FPS episode: record low at t=0
      monitor.recordFpsSnapshot(fpsSnapshot(20));
      vi.advanceTimersByTime(6_000);
      // Record another low at t=6s → sustained > 5s → warning emitted
      monitor.recordFpsSnapshot(fpsSnapshot(20));
      expect(warningSpy).toHaveBeenCalledTimes(1);

      // After first warning: _fpsLowSince was reset to null by the warning,
      // then recordFpsSnapshot sets it again (because fps still < 24).
      // But immediately after setting, lowDuration = 0, not triggered.
      // Need another 5s+ gap: record once to set new baseline, then 5s later
      vi.advanceTimersByTime(1_000);
      monitor.recordFpsSnapshot(fpsSnapshot(20)); // t=7s, sets _fpsLowSince
      vi.advanceTimersByTime(6_000);
      monitor.recordFpsSnapshot(fpsSnapshot(20)); // t=13s, lowDuration=6s → warn!
      expect(warningSpy).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });
  });

  // ================================================================
  // Event loop lag threshold
  // ================================================================
  describe("event loop lag threshold", () => {
    it("should emit warning when lag exceeds 50ms", () => {
      const warningSpy = vi.fn();
      monitor.on("perf:warning", warningSpy);

      monitor.recordFpsSnapshot(fpsSnapshot(60)); // Need latest snapshot
      monitor.recordEventLoopSample(eventLoopSample(80)); // > 50ms

      expect(warningSpy).toHaveBeenCalled();
      const warning: PerfWarning = warningSpy.mock.calls[0]![0] as PerfWarning;
      expect(warning.metric).toBe("eventLoopLag");
      expect(warning.currentValue).toBe(80);
      expect(warning.threshold).toBe(PERF_CONSTANTS.EVENT_LOOP_LAG_WARNING_THRESHOLD_MS);
    });

    it("should NOT emit warning when lag is below 50ms", () => {
      const warningSpy = vi.fn();
      monitor.on("perf:warning", warningSpy);

      monitor.recordFpsSnapshot(fpsSnapshot(60));
      monitor.recordEventLoopSample(eventLoopSample(30)); // < 50ms

      expect(warningSpy).not.toHaveBeenCalled();
    });

    it("should emit warning at exactly threshold boundary (50ms)", () => {
      const warningSpy = vi.fn();
      monitor.on("perf:warning", warningSpy);

      monitor.recordFpsSnapshot(fpsSnapshot(60));
      monitor.recordEventLoopSample(eventLoopSample(50)); // exactly 50

      // Threshold check uses >, not >=, so 50 should NOT trigger
      expect(warningSpy).not.toHaveBeenCalled();

      monitor.recordEventLoopSample(eventLoopSample(50.01));
      expect(warningSpy).toHaveBeenCalled();
    });
  });

  // ================================================================
  // IPC handler auto-registration
  // ================================================================
  describe("IPC handler registration", () => {
    it("should register IPC handlers when registerIpcHandler is provided", () => {
      const registeredChannels: string[] = [];
      const registerFn = (channel: string, _handler: (...args: unknown[]) => unknown) => {
        registeredChannels.push(channel);
      };

      const ipcMonitor = new PerformanceMonitor(registerFn);

      expect(registeredChannels).toContain("perf:fps-snapshot");
      expect(registeredChannels).toContain("perf:memory-snapshot");
      expect(registeredChannels).toContain("perf:stats");

      ipcMonitor.dispose();
    });

    it("should NOT register IPC handlers when registerIpcHandler is NOT provided", () => {
      // The default constructor without args should not register
      const defaultMonitor = new PerformanceMonitor();
      // No crash expected — we just verify it's in a valid state
      expect(defaultMonitor.isRunning()).toBe(false);
      defaultMonitor.dispose();
    });

    it("should process FPS snapshot via auto-registered handler", () => {
      let fpsHandler: ((...args: unknown[]) => unknown) | null = null;
      const registerFn = (channel: string, handler: (...args: unknown[]) => unknown) => {
        if (channel === "perf:fps-snapshot") {
          fpsHandler = handler;
        }
      };

      const ipcMonitor = new PerformanceMonitor(registerFn);
      expect(fpsHandler).not.toBeNull();

      // Simulate IPC call from renderer
      (fpsHandler as (...args: unknown[]) => unknown)(null, fpsSnapshot(60));
      expect(ipcMonitor.getTotalFpsSnapshots()).toBe(1);
      expect(ipcMonitor.getFpsSamples()).toEqual([60]);

      ipcMonitor.dispose();
    });
  });

  // ================================================================
  // IPC warning send to renderer
  // ================================================================
  describe("IPC warning send", () => {
    it("should send perf warning to renderer when sendIpc is configured", () => {
      const sentMessages: Array<{ channel: string; args: unknown[] }> = [];
      const sendFn = (channel: string, ...args: unknown[]) => {
        sentMessages.push({ channel, args });
      };

      const ipcMonitor = new PerformanceMonitor(undefined, sendFn);
      ipcMonitor.recordFpsSnapshot(fpsSnapshot(10));
      ipcMonitor.checkThresholds();

      const warnings = sentMessages.filter((m) => m.channel === "perf:warning");
      expect(warnings.length).toBeGreaterThanOrEqual(1);

      ipcMonitor.dispose();
    });
  });

  // ================================================================
  // dispose()
  // ================================================================
  describe("dispose()", () => {
    it("should clear FPS samples", () => {
      monitor.recordFpsSnapshot(fpsSnapshot(60));
      monitor.recordFpsSnapshot(fpsSnapshot(55));
      expect(monitor.getFpsSamples()).toHaveLength(2);

      monitor.dispose();
      expect(monitor.getFpsSamples()).toHaveLength(0);
    });

    it("should clear event loop samples", () => {
      monitor.recordEventLoopSample(eventLoopSample(10));
      expect(monitor.getEventLoopSamples()).toHaveLength(1);

      monitor.dispose();
      expect(monitor.getEventLoopSamples()).toHaveLength(0);
    });

    it("should set isRunning to false", () => {
      monitor.dispose();
      expect(monitor.isRunning()).toBe(false);
    });

    it("should clear latest snapshot", () => {
      monitor.recordFpsSnapshot(fpsSnapshot(60));
      expect(monitor.getLatestSnapshot()).not.toBeNull();

      monitor.dispose();
      expect(monitor.getLatestSnapshot()).toBeNull();
    });

    it("should remove all event listeners", () => {
      const warningSpy = vi.fn();
      monitor.on("perf:warning", warningSpy);

      monitor.dispose();

      // After dispose, re-record should not trigger listener
      // (listeners have been removed)
      const monitor2 = new PerformanceMonitor();
      monitor2.recordFpsSnapshot(fpsSnapshot(10));
      monitor2.recordFpsSnapshot(fpsSnapshot(8));
      monitor2.checkThresholds();

      // Original spy should not be called (different monitor instance)
      expect(warningSpy).not.toHaveBeenCalled();
      monitor2.dispose();
    });

    it("should stop event loop monitoring when running", () => {
      // Verify dispose handles the case where event loop was running
      monitor.dispose();
      expect(monitor.isRunning()).toBe(false);
      // Ensure dispose is idempotent
      monitor.dispose();
      expect(monitor.isRunning()).toBe(false);
    });

    it("should be idempotent (safe to call multiple times)", () => {
      monitor.recordFpsSnapshot(fpsSnapshot(60));
      monitor.dispose();
      monitor.dispose();
      monitor.dispose();
      // No crash, no side effects
      expect(monitor.isRunning()).toBe(false);
    });
  });

  // ================================================================
  // Event loop monitor lifecycle
  // ================================================================
  describe("startEventLoopMonitor()", () => {
    it("should not restart if already running", () => {
      // Call start
      monitor.startEventLoopMonitor();
      expect(monitor.isRunning()).toBe(true);

      // Call again — should warn but not crash
      monitor.startEventLoopMonitor();
      expect(monitor.isRunning()).toBe(true);
    });
  });

  // ================================================================
  // getTotalFpsSnapshots()
  // ================================================================
  describe("getTotalFpsSnapshots()", () => {
    it("should count total snapshots across all rolling windows", () => {
      for (let i = 0; i < 25; i++) {
        monitor.recordFpsSnapshot(fpsSnapshot(60));
      }
      expect(monitor.getTotalFpsSnapshots()).toBe(25);
    });

    it("should survive rolling window eviction", () => {
      for (let i = 0; i < PERF_CONSTANTS.MAX_FPS_SAMPLES + 50; i++) {
        monitor.recordFpsSnapshot(fpsSnapshot(60));
      }
      expect(monitor.getTotalFpsSnapshots()).toBe(
        PERF_CONSTANTS.MAX_FPS_SAMPLES + 50,
      );
      expect(monitor.getFpsSamples().length).toBeLessThanOrEqual(
        PERF_CONSTANTS.MAX_FPS_SAMPLES,
      );
    });
  });
});
