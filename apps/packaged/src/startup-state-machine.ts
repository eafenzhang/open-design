/**
 * Open Design — Startup State Machine
 *
 * Finite State Machine (FSM) for the application startup lifecycle.
 * Enforces valid state transitions, records transition history,
 * and supports reactive callbacks via on()/once() pattern.
 *
 * States: IDLE → LAUNCHER_STARTING → DAEMON_STARTING → DAEMON_READY →
 *         WINDOW_CREATING → WINDOW_READY → ROUTE_INIT → ROUTE_STABLE
 * Error:  DAEMON_FAILED | WINDOW_FAILED
 *
 * @module startup-state-machine
 */

import {
  StartupState,
  type StartupTransition,
  VALID_TRANSITIONS,
  isTerminalState,
  isErrorState,
} from "./types/startup-state.js";

/** Log prefix for this module. */
const LOG_PREFIX = "[OpenDesign:StartupStateMachine]";

/** Custom error class for startup state machine errors. */
export class StartupStateError extends Error {
  public readonly code: string;
  public readonly context: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "StartupStateError";
    this.code = code;
    this.context = context;
  }
}

/** Callback type for state listeners. */
type StateListener = (transition: StartupTransition) => void;

/**
 * Startup State Machine.
 *
 * Manages the deterministic startup lifecycle of the Open Design
 * Electron application. Only allows transitions defined in the
 * VALID_TRANSITIONS map and records all transitions for diagnostics.
 */
export class StartupStateMachine {
  /** Current state of the machine. */
  private _currentState: StartupState;

  /** Full history of state transitions (ordered, most recent last). */
  private readonly _history: StartupTransition[];

  /** Permanent listeners: called every time the state transitions to the target. */
  private readonly _listeners: Map<StartupState, StateListener[]>;

  /** One-shot listeners: called once then removed. */
  private readonly _onceListeners: Map<StartupState, StateListener[]>;

  /** Timestamp of machine creation (ISO 8601 UTC ms). */
  private readonly _createdAt: number;

  /** Maximum number of history entries to retain. */
  private readonly _maxHistorySize: number;

  /**
   * @param maxHistorySize - Maximum history entries (default: 1000).
   */
  constructor(maxHistorySize: number = 1_000) {
    this._currentState = StartupState.IDLE;
    this._history = [];
    this._listeners = new Map();
    this._onceListeners = new Map();
    this._createdAt = Date.now();
    this._maxHistorySize = maxHistorySize;

    console.info(`${LOG_PREFIX} State machine created. Initial state: IDLE`);
  }

  // ================================================================
  // Public API
  // ================================================================

  /**
   * Transition to a new state.
   *
   * Validates the transition against VALID_TRANSITIONS, records it
   * in the history, and notifies registered listeners.
   *
   * @param to - The target state.
   * @param metadata - Optional metadata for the transition record.
   * @throws {StartupStateError} If the transition is not valid.
   */
  transition(to: StartupState, metadata?: Record<string, unknown>): void {
    const from: StartupState = this._currentState;

    // Validate transition
    if (!this.canTransition(to)) {
      const allowed: readonly StartupState[] =
        VALID_TRANSITIONS.get(from) ?? [];

      throw new StartupStateError(
        "INVALID_TRANSITION",
        `Cannot transition from ${from} to ${to}. ` +
          `Allowed targets: [${allowed.join(", ") || "none"}]`,
        { from, to, currentState: this._currentState },
      );
    }

    const timestamp: number = Date.now();
    const transition: StartupTransition = {
      from,
      to,
      timestamp,
      metadata,
    };

    // Update state
    this._currentState = to;

    // Record history
    this._history.push(transition);
    if (this._history.length > this._maxHistorySize) {
      this._history.shift();
    }

    console.info(
      `${LOG_PREFIX} Transition: ${from} → ${to} [${new Date(timestamp).toISOString()}]`,
    );

    // Notify permanent listeners
    const stateListeners: StateListener[] | undefined =
      this._listeners.get(to);
    if (stateListeners) {
      for (const listener of stateListeners) {
        try {
          listener(transition);
        } catch (err) {
          console.error(
            `${LOG_PREFIX} Listener error for state ${to}:`,
            err,
          );
        }
      }
    }

    // Notify one-shot listeners and remove them
    const onceListeners: StateListener[] | undefined =
      this._onceListeners.get(to);
    if (onceListeners) {
      this._onceListeners.delete(to);
      for (const listener of onceListeners) {
        try {
          listener(transition);
        } catch (err) {
          console.error(
            `${LOG_PREFIX} Once-listener error for state ${to}:`,
            err,
          );
        }
      }
    }

    // If transitioned to an error state, log it prominently
    if (isErrorState(to)) {
      console.error(
        `${LOG_PREFIX} Entered error state: ${to}`,
        metadata ?? {},
      );
    }
  }

  /**
   * Register a callback to be called every time the machine transitions
   * TO the specified state.
   *
   * @param state - The target state to listen for.
   * @param callback - Function called with the transition record.
   */
  on(state: StartupState, callback: StateListener): void {
    const existing: StateListener[] = this._listeners.get(state) ?? [];
    existing.push(callback);
    this._listeners.set(state, existing);
  }

  /**
   * Register a callback to be called ONCE when the machine transitions
   * TO the specified state.
   *
   * @param state - The target state to listen for.
   * @param callback - Function called with the transition record.
   */
  once(state: StartupState, callback: StateListener): void {
    const existing: StateListener[] = this._onceListeners.get(state) ?? [];
    existing.push(callback);
    this._onceListeners.set(state, existing);
  }

  /**
   * Remove a listener. If callback is not provided, removes all
   * listeners for the given state.
   *
   * @param state - The state to remove listeners from.
   * @param callback - Optional specific callback to remove.
   */
  off(state: StartupState, callback?: StateListener): void {
    if (callback) {
      // Remove specific listener from permanent listeners
      const permListeners: StateListener[] | undefined =
        this._listeners.get(state);
      if (permListeners) {
        this._listeners.set(
          state,
          permListeners.filter((l) => l !== callback),
        );
      }

      // Remove specific listener from once listeners
      const onceListeners: StateListener[] | undefined =
        this._onceListeners.get(state);
      if (onceListeners) {
        this._onceListeners.set(
          state,
          onceListeners.filter((l) => l !== callback),
        );
      }
    } else {
      this._listeners.delete(state);
      this._onceListeners.delete(state);
    }
  }

  /**
   * Get the current state of the machine.
   */
  getCurrentState(): StartupState {
    return this._currentState;
  }

  /**
   * Get the full transition history.
   *
   * @returns Array of transitions, ordered from oldest to newest.
   */
  getHistory(): readonly StartupTransition[] {
    return [...this._history];
  }

  /**
   * Check if a transition to the target state is valid from the current state.
   *
   * @param to - The target state to check.
   * @returns true if the transition is allowed.
   */
  canTransition(to: StartupState): boolean {
    const allowed: readonly StartupState[] | undefined =
      VALID_TRANSITIONS.get(this._currentState);

    if (!allowed) {
      return false;
    }

    return allowed.includes(to);
  }

  /**
   * Get the list of states that can be transitioned to from the current state.
   */
  getAvailableTransitions(): readonly StartupState[] {
    return VALID_TRANSITIONS.get(this._currentState) ?? [];
  }

  /**
   * Check if the machine is in a terminal state.
   */
  isTerminal(): boolean {
    return isTerminalState(this._currentState);
  }

  /**
   * Check if the machine is in an error state.
   */
  isError(): boolean {
    return isErrorState(this._currentState);
  }

  /**
   * Get the elapsed time since the machine was created (in ms).
   */
  getElapsedMs(): number {
    return Date.now() - this._createdAt;
  }

  /**
   * Reset the state machine to IDLE and clear all history and listeners.
   */
  reset(): void {
    console.info(`${LOG_PREFIX} Resetting state machine.`);
    this._currentState = StartupState.IDLE;
    this._history.length = 0;
    this._listeners.clear();
    this._onceListeners.clear();
  }
}

export default StartupStateMachine;
