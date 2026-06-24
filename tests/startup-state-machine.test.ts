/**
 * Unit tests for StartupStateMachine — FSM transitions, validation,
 * listener registration, history tracking, and error handling.
 *
 * @module tests/unit/startup-state-machine
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  StartupStateMachine,
  StartupStateError,
} from "../../apps/packaged/src/startup-state-machine.js";
import { StartupState } from "../../apps/packaged/src/types/startup-state.js";
import type { StartupTransition } from "../../apps/packaged/src/types/startup-state.js";

describe("StartupStateMachine", () => {
  let fsm: StartupStateMachine;

  beforeEach(() => {
    fsm = new StartupStateMachine();
  });

  // ================================================================
  // Initial state
  // ================================================================
  describe("initial state", () => {
    it("should start in IDLE state", () => {
      expect(fsm.getCurrentState()).toBe(StartupState.IDLE);
    });

    it("should have empty history", () => {
      expect(fsm.getHistory()).toHaveLength(0);
    });

    it("should not be in terminal state initially", () => {
      expect(fsm.isTerminal()).toBe(false);
    });

    it("should not be in error state initially", () => {
      expect(fsm.isError()).toBe(false);
    });
  });

  // ================================================================
  // Valid transitions
  // ================================================================
  describe("valid transitions", () => {
    it("should transition IDLE → LAUNCHER_STARTING", () => {
      fsm.transition(StartupState.LAUNCHER_STARTING);
      expect(fsm.getCurrentState()).toBe(StartupState.LAUNCHER_STARTING);
    });

    it("should follow the full happy path", () => {
      const path: StartupState[] = [
        StartupState.LAUNCHER_STARTING,
        StartupState.DAEMON_STARTING,
        StartupState.DAEMON_READY,
        StartupState.WINDOW_CREATING,
        StartupState.WINDOW_READY,
        StartupState.ROUTE_INIT,
        StartupState.ROUTE_STABLE,
      ];

      for (const state of path) {
        fsm.transition(state);
        expect(fsm.getCurrentState()).toBe(state);
      }
    });

    it("should allow transition to DAEMON_FAILED from LAUNCHER_STARTING", () => {
      fsm.transition(StartupState.LAUNCHER_STARTING);
      fsm.transition(StartupState.DAEMON_FAILED);
      expect(fsm.getCurrentState()).toBe(StartupState.DAEMON_FAILED);
      expect(fsm.isError()).toBe(true);
    });

    it("should allow transition to DAEMON_FAILED from DAEMON_STARTING", () => {
      fsm.transition(StartupState.LAUNCHER_STARTING);
      fsm.transition(StartupState.DAEMON_STARTING);
      fsm.transition(StartupState.DAEMON_FAILED);
      expect(fsm.getCurrentState()).toBe(StartupState.DAEMON_FAILED);
    });

    it("should allow transition to WINDOW_FAILED from DAEMON_READY", () => {
      walkToState(fsm, StartupState.DAEMON_READY);
      fsm.transition(StartupState.WINDOW_FAILED);
      expect(fsm.getCurrentState()).toBe(StartupState.WINDOW_FAILED);
      expect(fsm.isError()).toBe(true);
    });

    it("should allow transition to WINDOW_FAILED from WINDOW_CREATING", () => {
      walkToState(fsm, StartupState.WINDOW_CREATING);
      fsm.transition(StartupState.WINDOW_FAILED);
      expect(fsm.getCurrentState()).toBe(StartupState.WINDOW_FAILED);
    });
  });

  // ================================================================
  // Invalid transitions
  // ================================================================
  describe("invalid transitions", () => {
    it("should reject IDLE → DAEMON_READY (skip states)", () => {
      expect(() => fsm.transition(StartupState.DAEMON_READY)).toThrow(
        StartupStateError,
      );
    });

    it("should reject IDLE → ROUTE_STABLE (skip states)", () => {
      expect(() => fsm.transition(StartupState.ROUTE_STABLE)).toThrow(
        StartupStateError,
      );
    });

    it("should reject transition from terminal ROUTE_STABLE", () => {
      walkToState(fsm, StartupState.ROUTE_STABLE);
      expect(() => fsm.transition(StartupState.LAUNCHER_STARTING)).toThrow(
        StartupStateError,
      );
    });

    it("should reject transition from terminal DAEMON_FAILED", () => {
      walkToState(fsm, StartupState.DAEMON_FAILED);
      expect(() => fsm.transition(StartupState.DAEMON_READY)).toThrow(
        StartupStateError,
      );
    });

    it("should reject transition from terminal WINDOW_FAILED", () => {
      walkToState(fsm, StartupState.WINDOW_FAILED);
      expect(() => fsm.transition(StartupState.ROUTE_STABLE)).toThrow(
        StartupStateError,
      );
    });

    it("should include error context in StartupStateError", () => {
      try {
        fsm.transition(StartupState.ROUTE_STABLE);
        expect.unreachable("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(StartupStateError);
        const stateErr = err as StartupStateError;
        expect(stateErr.code).toBe("INVALID_TRANSITION");
        expect(stateErr.context).toHaveProperty("from");
        expect(stateErr.context).toHaveProperty("to");
        expect(stateErr.context["from"]).toBe(StartupState.IDLE);
        expect(stateErr.context["to"]).toBe(StartupState.ROUTE_STABLE);
      }
    });
  });

  // ================================================================
  // canTransition()
  // ================================================================
  describe("canTransition()", () => {
    it("should return true for valid next states", () => {
      expect(fsm.canTransition(StartupState.LAUNCHER_STARTING)).toBe(true);
    });

    it("should return false for invalid next states", () => {
      expect(fsm.canTransition(StartupState.ROUTE_STABLE)).toBe(false);
    });
  });

  // ================================================================
  // getAvailableTransitions()
  // ================================================================
  describe("getAvailableTransitions()", () => {
    it("should return LAUNCHER_STARTING from IDLE", () => {
      const available = fsm.getAvailableTransitions();
      expect(available).toContain(StartupState.LAUNCHER_STARTING);
      expect(available).toHaveLength(1);
    });

    it("should return PERFORMANCE_READY from ROUTE_STABLE", () => {
      walkToState(fsm, StartupState.ROUTE_STABLE);
      const available = fsm.getAvailableTransitions();
      expect(available).toContain(StartupState.PERFORMANCE_READY);
      expect(available).toHaveLength(1);
    });

    it("should return empty array from PERFORMANCE_READY (terminal)", () => {
      walkToState(fsm, StartupState.PERFORMANCE_READY);
      expect(fsm.getAvailableTransitions()).toHaveLength(0);
    });
  });

  // ================================================================
  // History
  // ================================================================
  describe("history", () => {
    it("should record every transition", () => {
      const path: StartupState[] = [
        StartupState.LAUNCHER_STARTING,
        StartupState.DAEMON_STARTING,
        StartupState.DAEMON_READY,
      ];

      for (const state of path) {
        fsm.transition(state);
      }

      const history = fsm.getHistory();
      expect(history).toHaveLength(3);
      expect(history[0]!.from).toBe(StartupState.IDLE);
      expect(history[0]!.to).toBe(StartupState.LAUNCHER_STARTING);
      expect(history[2]!.to).toBe(StartupState.DAEMON_READY);
    });

    it("should record timestamps in chronological order", () => {
      fsm.transition(StartupState.LAUNCHER_STARTING);
      fsm.transition(StartupState.DAEMON_STARTING);

      const history = fsm.getHistory();
      expect(history[0]!.timestamp).toBeLessThanOrEqual(history[1]!.timestamp);
    });

    it("should store metadata in transition records", () => {
      const metadata = { daemonPid: 1234, reason: "test" };
      fsm.transition(StartupState.LAUNCHER_STARTING, metadata);

      const history = fsm.getHistory();
      expect(history[0]!.metadata).toEqual(metadata);
    });

    it("should cap history size at maxHistorySize", () => {
      const smallFsm = new StartupStateMachine(3); // max 3 entries

      // Go through the happy path, which creates 7 transitions
      const path: StartupState[] = [
        StartupState.LAUNCHER_STARTING,
        StartupState.DAEMON_STARTING,
        StartupState.DAEMON_READY,
        StartupState.WINDOW_CREATING,
        StartupState.WINDOW_READY,
        StartupState.ROUTE_INIT,
        StartupState.ROUTE_STABLE,
      ];

      for (const state of path) {
        smallFsm.transition(state);
      }

      // History should be capped at 3
      expect(smallFsm.getHistory()).toHaveLength(3);
    });

    it("should return a copy of history (immutable)", () => {
      fsm.transition(StartupState.LAUNCHER_STARTING);
      const history = fsm.getHistory();
      (history as unknown as Array<unknown>).pop(); // Mutate the copy
      expect(fsm.getHistory()).toHaveLength(1); // Original unaffected
    });
  });

  // ================================================================
  // Listeners: on()
  // ================================================================
  describe("on() listeners", () => {
    it("should call listener when transitioning to target state", () => {
      const spy = vi.fn();
      fsm.on(StartupState.DAEMON_READY, spy);

      fsm.transition(StartupState.LAUNCHER_STARTING);
      expect(spy).not.toHaveBeenCalled();

      walkToState(fsm, StartupState.DAEMON_READY);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("should pass the transition record to the listener", () => {
      const spy = vi.fn();
      fsm.on(StartupState.LAUNCHER_STARTING, spy);

      fsm.transition(StartupState.LAUNCHER_STARTING, { key: "value" });

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          from: StartupState.IDLE,
          to: StartupState.LAUNCHER_STARTING,
          metadata: { key: "value" },
        }),
      );
    });

    it("should call multiple listeners for the same state", () => {
      const spy1 = vi.fn();
      const spy2 = vi.fn();
      fsm.on(StartupState.LAUNCHER_STARTING, spy1);
      fsm.on(StartupState.LAUNCHER_STARTING, spy2);

      fsm.transition(StartupState.LAUNCHER_STARTING);

      expect(spy1).toHaveBeenCalledTimes(1);
      expect(spy2).toHaveBeenCalledTimes(1);
    });

    it("should not stop other listeners if one throws", () => {
      const badSpy = vi.fn().mockImplementation(() => {
        throw new Error("Listener error");
      });
      const goodSpy = vi.fn();

      fsm.on(StartupState.LAUNCHER_STARTING, badSpy);
      fsm.on(StartupState.LAUNCHER_STARTING, goodSpy);

      fsm.transition(StartupState.LAUNCHER_STARTING);

      // Good listener should still be called
      expect(goodSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ================================================================
  // Listeners: once()
  // ================================================================
  describe("once() listeners", () => {
    it("should call listener exactly once", () => {
      // We need to reset and go through the path again
      fsm.reset();

      const spy = vi.fn();
      fsm.once(StartupState.LAUNCHER_STARTING, spy);

      fsm.transition(StartupState.LAUNCHER_STARTING);
      expect(spy).toHaveBeenCalledTimes(1);

      // Reset and go again
      fsm.reset();
      fsm.transition(StartupState.LAUNCHER_STARTING);
      // Should not be called again
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  // ================================================================
  // off()
  // ================================================================
  describe("off()", () => {
    it("should remove a specific listener", () => {
      const spy = vi.fn();
      fsm.on(StartupState.LAUNCHER_STARTING, spy);
      fsm.off(StartupState.LAUNCHER_STARTING, spy);

      fsm.transition(StartupState.LAUNCHER_STARTING);
      expect(spy).not.toHaveBeenCalled();
    });

    it("should remove all listeners for a state when no callback specified", () => {
      const spy1 = vi.fn();
      const spy2 = vi.fn();
      fsm.on(StartupState.LAUNCHER_STARTING, spy1);
      fsm.on(StartupState.LAUNCHER_STARTING, spy2);
      fsm.off(StartupState.LAUNCHER_STARTING);

      fsm.transition(StartupState.LAUNCHER_STARTING);
      expect(spy1).not.toHaveBeenCalled();
      expect(spy2).not.toHaveBeenCalled();
    });
  });

  // ================================================================
  // reset()
  // ================================================================
  describe("reset()", () => {
    it("should reset to IDLE and clear history", () => {
      fsm.transition(StartupState.LAUNCHER_STARTING);
      fsm.transition(StartupState.DAEMON_STARTING);

      expect(fsm.getCurrentState()).not.toBe(StartupState.IDLE);
      expect(fsm.getHistory()).toHaveLength(2);

      fsm.reset();

      expect(fsm.getCurrentState()).toBe(StartupState.IDLE);
      expect(fsm.getHistory()).toHaveLength(0);
    });

    it("should clear all listeners", () => {
      const spy = vi.fn();
      fsm.on(StartupState.LAUNCHER_STARTING, spy);
      fsm.reset();

      fsm.transition(StartupState.LAUNCHER_STARTING);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // ================================================================
  // getElapsedMs()
  // ================================================================
  describe("getElapsedMs()", () => {
    it("should return positive elapsed time after creation", () => {
      expect(fsm.getElapsedMs()).toBeGreaterThanOrEqual(0);
    });
  });

  // ================================================================
  // isTerminal() / isError()
  // ================================================================
  describe("isTerminal() / isError()", () => {
    it("should report PERFORMANCE_READY as terminal", () => {
      walkToState(fsm, StartupState.PERFORMANCE_READY);
      expect(fsm.isTerminal()).toBe(true);
    });

    it("should not report ROUTE_STABLE as terminal (can go to PERFORMANCE_READY)", () => {
      walkToState(fsm, StartupState.ROUTE_STABLE);
      expect(fsm.isTerminal()).toBe(false);
      expect(fsm.getAvailableTransitions()).toContain(StartupState.PERFORMANCE_READY);
    });

    it("should report DAEMON_FAILED as both terminal and error", () => {
      walkToState(fsm, StartupState.DAEMON_FAILED);
      expect(fsm.isTerminal()).toBe(true);
      expect(fsm.isError()).toBe(true);
    });

    it("should not report working states as terminal", () => {
      walkToState(fsm, StartupState.DAEMON_READY);
      expect(fsm.isTerminal()).toBe(false);
      expect(fsm.isError()).toBe(false);
    });
  });

  // ================================================================
  // PERFORMANCE_READY — new terminal state
  // ================================================================
  describe("PERFORMANCE_READY state", () => {
    it("should allow ROUTE_INIT → PERFORMANCE_READY", () => {
      walkToState(fsm, StartupState.ROUTE_INIT);
      fsm.transition(StartupState.PERFORMANCE_READY);
      expect(fsm.getCurrentState()).toBe(StartupState.PERFORMANCE_READY);
      expect(fsm.isTerminal()).toBe(true);
    });

    it("should allow ROUTE_STABLE → PERFORMANCE_READY", () => {
      walkToState(fsm, StartupState.ROUTE_STABLE);
      fsm.transition(StartupState.PERFORMANCE_READY);
      expect(fsm.getCurrentState()).toBe(StartupState.PERFORMANCE_READY);
    });

    it("should be a terminal state (no further transitions)", () => {
      walkToState(fsm, StartupState.PERFORMANCE_READY);
      expect(fsm.isTerminal()).toBe(true);
      expect(fsm.isError()).toBe(false);
      expect(fsm.getAvailableTransitions()).toHaveLength(0);
    });

    it("should reject transitions from PERFORMANCE_READY", () => {
      walkToState(fsm, StartupState.PERFORMANCE_READY);
      expect(() => fsm.transition(StartupState.ROUTE_STABLE)).toThrow(
        StartupStateError,
      );
    });

    it("should allow full happy path including PERFORMANCE_READY", () => {
      const path: StartupState[] = [
        StartupState.LAUNCHER_STARTING,
        StartupState.DAEMON_STARTING,
        StartupState.DAEMON_READY,
        StartupState.WINDOW_CREATING,
        StartupState.WINDOW_READY,
        StartupState.ROUTE_INIT,
        StartupState.ROUTE_STABLE,
        StartupState.PERFORMANCE_READY,
      ];

      for (const state of path) {
        fsm.transition(state);
      }

      expect(fsm.getCurrentState()).toBe(StartupState.PERFORMANCE_READY);
      expect(fsm.isTerminal()).toBe(true);
      expect(fsm.getHistory()).toHaveLength(8);
    });

    it("should not be considered an error state", () => {
      walkToState(fsm, StartupState.PERFORMANCE_READY);
      expect(fsm.isError()).toBe(false);
    });
  });
});

// ================================================================
// Helper
// ================================================================

/** Walk the FSM through states to reach a target state. */
function walkToState(fsm: StartupStateMachine, target: StartupState): void {
  const path: StartupState[] = getPathToState(target);

  if (path.length === 0) {
    return; // Already at target or target is IDLE
  }

  // If FSM is not at IDLE, reset it
  if (fsm.getCurrentState() !== StartupState.IDLE) {
    // We need to transition forward from where we are
    // This function assumes we start from wherever the FSM currently is
  }

  for (const state of path) {
    if (fsm.getCurrentState() === state) continue;
    fsm.transition(state);
  }
}

/** Get the sequence of states to reach a target from IDLE. */
function getPathToState(target: StartupState): StartupState[] {
  const happyPath: StartupState[] = [
    StartupState.LAUNCHER_STARTING,
    StartupState.DAEMON_STARTING,
    StartupState.DAEMON_READY,
    StartupState.WINDOW_CREATING,
    StartupState.WINDOW_READY,
    StartupState.ROUTE_INIT,
    StartupState.ROUTE_STABLE,
    StartupState.PERFORMANCE_READY,
  ];

  const targetIndex: number = happyPath.indexOf(target);
  if (targetIndex >= 0) {
    return happyPath.slice(0, targetIndex + 1);
  }

  // Error states
  if (target === StartupState.DAEMON_FAILED) {
    return [
      StartupState.LAUNCHER_STARTING,
      StartupState.DAEMON_FAILED,
    ];
  }

  if (target === StartupState.WINDOW_FAILED) {
    return [
      StartupState.LAUNCHER_STARTING,
      StartupState.DAEMON_STARTING,
      StartupState.DAEMON_READY,
      StartupState.WINDOW_FAILED,
    ];
  }

  return [];
}

