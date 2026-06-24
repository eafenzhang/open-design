/**
 * Open Design — Startup State Enumeration
 *
 * Defines the finite state machine states for the application startup
 * lifecycle. The states form a directed acyclic graph from IDLE through
 * the normal startup path, with two terminal error states.
 *
 * @module types/startup-state
 */

/** Ordered startup lifecycle states and error terminal states. */
export enum StartupState {
  /** Initial state before any startup activity. */
  IDLE = "IDLE",

  /** Launcher process has begun initialization. */
  LAUNCHER_STARTING = "LAUNCHER_STARTING",

  /** Daemon sidecar process is being spawned. */
  DAEMON_STARTING = "DAEMON_STARTING",

  /** Daemon is alive and responding to health checks. */
  DAEMON_READY = "DAEMON_READY",

  /** BrowserWindow is being created with GPU configuration. */
  WINDOW_CREATING = "WINDOW_CREATING",

  /** BrowserWindow has been created and is ready. */
  WINDOW_READY = "WINDOW_READY",

  /** Next.js renderer is initializing client-side routing. */
  ROUTE_INIT = "ROUTE_INIT",

  /** Application routing is stable; UI is fully interactive. */
  ROUTE_STABLE = "ROUTE_STABLE",

  /** Performance monitoring subsystem is initialized and running. */
  PERFORMANCE_READY = "PERFORMANCE_READY",

  /** Daemon process failed to start or crashed during startup. */
  DAEMON_FAILED = "DAEMON_FAILED",

  /** BrowserWindow failed to create. */
  WINDOW_FAILED = "WINDOW_FAILED",
}

/**
 * Records a single state transition in the state machine history.
 * Each transition captures the source state, destination state,
 * timestamp, and optional metadata.
 */
export interface StartupTransition {
  /** The state the machine is transitioning from. */
  from: StartupState;

  /** The state the machine is transitioning to. */
  to: StartupState;

  /** ISO 8601 UTC timestamp of the transition in milliseconds. */
  timestamp: number;

  /** Optional contextual metadata for the transition (e.g., daemon PID, GPU info). */
  metadata?: Record<string, unknown>;
}

/**
 * Valid transition map: for each current state, lists the allowed target states.
 * Any transition not in this map will be rejected by StartupStateMachine.
 */
export const VALID_TRANSITIONS: ReadonlyMap<StartupState, readonly StartupState[]> =
  new Map([
    [StartupState.IDLE, [StartupState.LAUNCHER_STARTING]],
    [
      StartupState.LAUNCHER_STARTING,
      [StartupState.DAEMON_STARTING, StartupState.DAEMON_FAILED],
    ],
    [
      StartupState.DAEMON_STARTING,
      [StartupState.DAEMON_READY, StartupState.DAEMON_FAILED],
    ],
    [
      StartupState.DAEMON_READY,
      [StartupState.WINDOW_CREATING, StartupState.WINDOW_FAILED],
    ],
    [
      StartupState.WINDOW_CREATING,
      [StartupState.WINDOW_READY, StartupState.WINDOW_FAILED],
    ],
    [StartupState.WINDOW_READY, [StartupState.ROUTE_INIT]],
    [StartupState.ROUTE_INIT, [StartupState.ROUTE_STABLE, StartupState.PERFORMANCE_READY]],
    [StartupState.ROUTE_STABLE, [StartupState.PERFORMANCE_READY]],
    // Terminal states — no further transitions allowed
    [StartupState.PERFORMANCE_READY, []],
    [StartupState.DAEMON_FAILED, []],
    [StartupState.WINDOW_FAILED, []],
  ]);

/** Check if a state is a terminal (error or stable) state. */
export function isTerminalState(state: StartupState): boolean {
  const targets: readonly StartupState[] | undefined =
    VALID_TRANSITIONS.get(state);
  return targets !== undefined && targets.length === 0;
}

/** Check if a state is an error state. */
export function isErrorState(state: StartupState): boolean {
  return state === StartupState.DAEMON_FAILED || state === StartupState.WINDOW_FAILED;
}
