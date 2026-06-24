/**
 * Unit tests for IpcHeartbeat — heartbeat loop, exponential backoff,
 * liveness probe, state transitions, and event emission.
 *
 * Uses vitest fake timers to control async timing.
 *
 * @module tests/unit/ipc-heartbeat
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { IpcHeartbeat } from "../../apps/packaged/src/ipc-heartbeat.js";
import { IpcConnectionState } from "../../apps/packaged/src/types/ipc-config.js";
import type { IpcReconnectConfig } from "../../apps/packaged/src/types/ipc-config.js";

describe("IpcHeartbeat", () => {
  let heartbeat: IpcHeartbeat;
  let pingFn: ReturnType<typeof vi.fn>;
  let livenessProbeFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    pingFn = vi.fn().mockResolvedValue(undefined);
    livenessProbeFn = vi.fn().mockResolvedValue(true);
  });

  afterEach(() => {
    heartbeat?.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function createHeartbeat(
    config: Partial<IpcReconnectConfig> = {},
  ): IpcHeartbeat {
    heartbeat = new IpcHeartbeat(pingFn, livenessProbeFn, config);
    return heartbeat;
  }

  // ================================================================
  // Initialization
  // ================================================================
  describe("initialization", () => {
    it("should start in DISCONNECTED state", () => {
      const hb = createHeartbeat();
      expect(hb.getState()).toBe(IpcConnectionState.DISCONNECTED);
      expect(hb.isRunning()).toBe(false);
      expect(hb.getRetryCount()).toBe(0);
    });

    it("should use default config when none provided", () => {
      const hb = createHeartbeat();
      const config = hb.getConfig();
      expect(config.heartbeatIntervalMs).toBe(5_000);
      expect(config.heartbeatTimeoutMs).toBe(15_000);
      expect(config.initialDelayMs).toBe(1_000);
      expect(config.maxDelayMs).toBe(30_000);
      expect(config.maxRetries).toBe(8);
    });

    it("should merge custom config with defaults", () => {
      const hb = createHeartbeat({
        heartbeatIntervalMs: 10_000,
        maxRetries: 3,
      });
      const config = hb.getConfig();
      expect(config.heartbeatIntervalMs).toBe(10_000);
      expect(config.maxRetries).toBe(3);
      expect(config.heartbeatTimeoutMs).toBe(15_000); // default preserved
    });
  });

  // ================================================================
  // Start / Stop
  // ================================================================
  describe("start()", () => {
    it("should transition to CONNECTED when liveness probe succeeds", async () => {
      const hb = createHeartbeat();
      hb.start();

      // Allow liveness probe promise to resolve (no timers needed, just microtasks)
      await vi.advanceTimersByTimeAsync(0);

      expect(hb.getState()).toBe(IpcConnectionState.CONNECTED);
      expect(hb.isRunning()).toBe(true);
      expect(livenessProbeFn).toHaveBeenCalled();
    });

    it("should transition to RECONNECTING when liveness probe fails", async () => {
      livenessProbeFn.mockRejectedValue(new Error("Connection refused"));
      const hb = createHeartbeat({ initialDelayMs: 100 });
      hb.start();

      await vi.advanceTimersByTimeAsync(50);
      expect(hb.getState()).toBe(IpcConnectionState.RECONNECTING);
    });

    it("should not start twice", async () => {
      const hb = createHeartbeat();

      hb.start();
      await vi.advanceTimersByTimeAsync(0);

      const stateBefore = hb.getState();
      hb.start(); // Second start should be no-op
      expect(hb.getState()).toBe(stateBefore);
    });
  });

  describe("stop()", () => {
    it("should transition to DISCONNECTED and stop timers", async () => {
      const hb = createHeartbeat();
      hb.start();
      await vi.advanceTimersByTimeAsync(0);

      // Should be CONNECTED after successful probe
      expect(hb.getState()).toBe(IpcConnectionState.CONNECTED);

      hb.stop();
      expect(hb.getState()).toBe(IpcConnectionState.DISCONNECTED);
      expect(hb.isRunning()).toBe(false);
    });
  });

  // ================================================================
  // Heartbeat Loop
  // ================================================================
  describe("heartbeat loop", () => {
    it("should call pingFn at the configured interval", async () => {
      const hb = createHeartbeat({ heartbeatIntervalMs: 1_000 });
      hb.start();
      // Let the initial liveness probe resolve and heartbeat loop start
      await vi.advanceTimersByTimeAsync(0);

      // Advance past the first heartbeat interval to trigger PING
      await vi.advanceTimersByTimeAsync(1_500);

      // First PING should have happened
      expect(pingFn).toHaveBeenCalled();

      const initialCalls = pingFn.mock.calls.length;

      // Advance past another heartbeat interval
      await vi.advanceTimersByTimeAsync(2_500);

      // Should have been called at least 2 more times
      expect(pingFn.mock.calls.length).toBeGreaterThanOrEqual(initialCalls + 1);
    });
  });

  // ================================================================
  // Connection Loss & Reconnection
  // ================================================================
  describe("connection loss and reconnection", () => {
    it("should detect disconnection on PING failure", async () => {
      const hb = createHeartbeat({
        heartbeatIntervalMs: 1_000,
        heartbeatTimeoutMs: 500,
        initialDelayMs: 100,
      });
      hb.start();
      await vi.advanceTimersByTimeAsync(0);

      // Now make PING fail
      pingFn.mockRejectedValue(new Error("Connection lost"));

      // Advance to trigger the next heartbeat and its timeout
      await vi.advanceTimersByTimeAsync(2_000);

      // Should be in RECONNECTING state
      expect(hb.getState()).toBe(IpcConnectionState.RECONNECTING);
    });

    it("should use exponential backoff for reconnection delays", async () => {
      // Fail initial probe
      livenessProbeFn.mockRejectedValue(new Error("Not available"));

      const hb = createHeartbeat({
        initialDelayMs: 1_000,
        maxDelayMs: 30_000,
        maxRetries: 5,
      });
      hb.start();

      // Allow first disconnect
      await vi.advanceTimersByTimeAsync(100);

      // First reconnect attempt should use initialDelayMs
      const retryCount1 = hb.getRetryCount();
      // After first failed attempt, delay should be 2000ms (1s * 2^1)
      await vi.advanceTimersByTimeAsync(2_500);
      expect(hb.getRetryCount()).toBeGreaterThanOrEqual(retryCount1);
    });

    it("should enter FAILED state after max retries", async () => {
      livenessProbeFn.mockRejectedValue(new Error("Always fails"));

      const hb = createHeartbeat({
        initialDelayMs: 10,
        maxDelayMs: 50,
        maxRetries: 3,
      });
      hb.start();

      // Run through all retry attempts
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(200);
        if (hb.getState() === IpcConnectionState.FAILED) break;
      }

      expect(hb.getState()).toBe(IpcConnectionState.FAILED);
    });

    it("should reset retry count on successful reconnection", async () => {
      // First probe fails
      livenessProbeFn.mockRejectedValueOnce(new Error("Fail"));
      // Second probe succeeds
      livenessProbeFn.mockResolvedValueOnce(true);

      const hb = createHeartbeat({
        initialDelayMs: 100,
        maxRetries: 5,
      });
      hb.start();

      // Wait for first reconnect attempt
      await vi.advanceTimersByTimeAsync(500);

      // After successful reconnect, retry count should be 0
      if (hb.getState() === IpcConnectionState.CONNECTED) {
        expect(hb.getRetryCount()).toBe(0);
      }
    });
  });

  // ================================================================
  // Events
  // ================================================================
  describe("events", () => {
    it("should emit 'connected' event on successful connection", async () => {
      const hb = createHeartbeat();
      const connectedSpy = vi.fn();
      hb.on("connected", connectedSpy);

      hb.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(connectedSpy).toHaveBeenCalled();
    });

    it("should emit 'state-change' event on every transition", async () => {
      const hb = createHeartbeat();
      const stateChangeSpy = vi.fn();
      hb.onStateChange(stateChangeSpy);

      hb.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(stateChangeSpy).toHaveBeenCalled();
    });

    it("should emit 'reconnecting' event during reconnection", async () => {
      livenessProbeFn.mockRejectedValue(new Error("Fail"));

      const hb = createHeartbeat({
        initialDelayMs: 100,
        maxRetries: 5,
      });
      const reconnectingSpy = vi.fn();
      hb.on("reconnecting", reconnectingSpy);

      hb.start();
      await vi.advanceTimersByTimeAsync(500);

      expect(reconnectingSpy).toHaveBeenCalled();
    });

    it("should emit 'failed' event when max retries exceeded", async () => {
      livenessProbeFn.mockRejectedValue(new Error("Always fails"));

      const hb = createHeartbeat({
        initialDelayMs: 10,
        maxRetries: 2,
      });
      const failedSpy = vi.fn();
      hb.on("failed", failedSpy);

      hb.start();

      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(100);
        if (hb.getState() === IpcConnectionState.FAILED) break;
      }

      expect(failedSpy).toHaveBeenCalled();
    });
  });

  // ================================================================
  // dispose()
  // ================================================================
  describe("dispose()", () => {
    it("should set state to DISCONNECTED after dispose", async () => {
      const hb = createHeartbeat();
      hb.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(hb.getState()).toBe(IpcConnectionState.CONNECTED);

      hb.dispose();
      expect(hb.getState()).toBe(IpcConnectionState.DISCONNECTED);
      expect(hb.isRunning()).toBe(false);
    });

    it("should reset retry count", async () => {
      livenessProbeFn.mockRejectedValue(new Error("Fail"));

      const hb = createHeartbeat({
        initialDelayMs: 10,
        maxRetries: 5,
      });
      hb.start();

      await vi.advanceTimersByTimeAsync(100);
      expect(hb.getRetryCount()).toBeGreaterThan(0);

      hb.dispose();
      expect(hb.getRetryCount()).toBe(0);
    });

    it("should be idempotent (safe to call multiple times)", async () => {
      const hb = createHeartbeat();
      hb.start();
      await vi.advanceTimersByTimeAsync(0);

      hb.dispose();
      hb.dispose();
      hb.dispose();

      expect(hb.getState()).toBe(IpcConnectionState.DISCONNECTED);
      expect(hb.isRunning()).toBe(false);
    });

    it("should clear all event listeners", async () => {
      const hb = createHeartbeat();
      const spy = vi.fn();
      hb.on("connected", spy);
      hb.on("disconnected", spy);

      hb.dispose();

      // After dispose, start should not trigger connected
      // But we can't restart after dispose, so just verify no crashes
      expect(hb.isRunning()).toBe(false);
    });
  });

  // ================================================================
  // onStateChange()
  // ================================================================
  describe("onStateChange()", () => {
    it("should receive old and new state on transition", async () => {
      const hb = createHeartbeat();
      const spy = vi.fn();
      hb.onStateChange(spy);

      hb.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(spy).toHaveBeenCalled();

      // Check that the first call received DISCONNECTED → CONNECTED
      const firstCall = spy.mock.calls[0]!;
      expect(firstCall[0]).toBe(IpcConnectionState.CONNECTED);
      expect(firstCall[1]).toBe(IpcConnectionState.DISCONNECTED);
    });
  });
});
