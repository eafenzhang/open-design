/**
 * Open Design — Launcher Runtime (Refactored)
 *
 * Core launcher runtime for the Open Design desktop application.
 * This module has been refactored to delegate specialized responsibilities:
 *
 * - GPU detection → GpuDetector
 * - IPC connection → IpcHeartbeat + SidecarManager
 * - State management → StartupStateMachine
 * - Cold start optimization → ColdStartOptimizer
 * - Update health checks → UpdaterHealthCheck
 * - Lifecycle hooks → WindowsLifecycle
 *
 * The launcher now acts as an orchestrator, wiring modules together
 * and managing the top-level startup flow. Target size: ~8KB.
 *
 * @module launcher-runtime
 */

import { StartupStateMachine } from "./startup-state-machine.js";
import { StartupState } from "./types/startup-state.js";
import type { StartupTransition } from "./types/startup-state.js";
import { GpuDetector } from "./gpu-detector.js";
import type { GpuCapability } from "./types/gpu-capability.js";
import { IpcHeartbeat } from "./ipc-heartbeat.js";
import { IpcConnectionState } from "./types/ipc-config.js";
import { WindowsLifecycle } from "./windows-lifecycle.js";
import { ColdStartOptimizer } from "./cold-start-optimizer.js";
import { UpdaterHealthCheck } from "./updater-health-check.js";
import { SidecarManager } from "./sidecars.js";
import type { SidecarConfig } from "./sidecars.js";
import { PathUtils } from "./path-utils.js";
import type { ElectronAppProxy } from "./gpu-detector.js";
import type { LazyLoadConfig } from "./cold-start-optimizer.js";

/** Log prefix for this module. */
const LOG_PREFIX = "[OpenDesign:LauncherRuntime]";

/** Launcher runtime configuration. */
export interface LauncherConfig {
  /** Daemon sidecar configuration. */
  daemon: SidecarConfig;

  /** Path to the SQLite database. */
  dbPath: string;

  /** Path to the app.asar. */
  asarPath: string;

  /** Path to the application directory. */
  appPath: string;

  /** Directory for logs. */
  logDir: string;

  /** Startup state machine (injected for testability). */
  fsm?: StartupStateMachine;
}

/** Default launcher configuration. */
const DEFAULT_LAUNCHER_CONFIG: Partial<LauncherConfig> = {
  dbPath: "",
  asarPath: "",
  appPath: "",
  logDir: "",
};

/**
 * Launcher Runtime — the main orchestrator for application startup.
 *
 * This class wires together all Windows optimization modules:
 * GpuDetector, IpcHeartbeat, StartupStateMachine, ColdStartOptimizer,
 * UpdaterHealthCheck, and WindowsLifecycle.
 *
 * The launcher follows the state machine flow:
 * IDLE → LAUNCHER_STARTING → DAEMON_STARTING → DAEMON_READY →
 * WINDOW_CREATING → WINDOW_READY → ROUTE_INIT → ROUTE_STABLE
 */
export class LauncherRuntime {
  private readonly _config: LauncherConfig;
  private readonly _fsm: StartupStateMachine;

  // Module instances
  private _gpuDetector: GpuDetector | null;
  private _coldStartOptimizer: ColdStartOptimizer | null;
  private _updaterHealthCheck: UpdaterHealthCheck | null;
  private _daemonSidecar: SidecarManager | null;
  private _ipcHeartbeat: IpcHeartbeat | null;
  private _lifecycle: WindowsLifecycle | null;
  private _gpuCapability: GpuCapability | null;
  private _lazyLoadConfig: LazyLoadConfig | null;

  /** Promise that resolves when the app reaches ROUTE_STABLE or an error state. */
  private _readyPromise: Promise<StartupState>;
  private _readyResolve!: (state: StartupState) => void;

  /** Whether the launcher has been started. */
  private _isStarted: boolean;

  /**
   * @param electronApp - Electron app proxy (null for testing).
   * @param config - Launcher configuration.
   */
  constructor(
    electronApp: ElectronAppProxy | null,
    config: Partial<LauncherConfig> = {},
  ) {
    this._config = { ...DEFAULT_LAUNCHER_CONFIG, ...config } as LauncherConfig;
    this._fsm = this._config.fsm ?? new StartupStateMachine();
    this._gpuDetector = new GpuDetector(electronApp);
    this._coldStartOptimizer = null;
    this._updaterHealthCheck = null;
    this._daemonSidecar = null;
    this._ipcHeartbeat = null;
    this._lifecycle = null;
    this._gpuCapability = null;
    this._lazyLoadConfig = null;
    this._isStarted = false;

    this._readyPromise = new Promise<StartupState>((resolve) => {
      this._readyResolve = resolve;
    });

    this._initModules();
    this._registerStateListeners();
  }

  /**
   * Start the launcher and begin the startup sequence.
   *
   * @returns Promise that resolves when the app reaches a terminal state.
   */
  async start(): Promise<StartupState> {
    if (this._isStarted) {
      console.warn(`${LOG_PREFIX} Launcher already started.`);
      return this._fsm.getCurrentState();
    }

    this._isStarted = true;
    console.info(`${LOG_PREFIX} Starting launcher runtime...`);

    try {
      await this._executeStartupSequence();
    } catch (err) {
      console.error(`${LOG_PREFIX} Startup sequence failed:`, err);
      this._handleStartupError(err);
    }

    return this._readyPromise;
  }

  /**
   * Wait for the application to be ready (ROUTE_STABLE or error).
   */
  async waitForReady(): Promise<StartupState> {
    return this._readyPromise;
  }

  /**
   * Get the current startup state.
   */
  getState(): StartupState {
    return this._fsm.getCurrentState();
  }

  /**
   * Get the GPU capability result.
   */
  getGpuCapability(): GpuCapability | null {
    return this._gpuCapability;
  }

  /**
   * Get the lazy load configuration.
   */
  getLazyLoadConfig(): LazyLoadConfig | null {
    return this._lazyLoadConfig;
  }

  /**
   * Get the IPC heartbeat instance.
   */
  getHeartbeat(): IpcHeartbeat | null {
    return this._ipcHeartbeat;
  }

  /**
   * Get the startup state machine.
   */
  getStateMachine(): StartupStateMachine {
    return this._fsm;
  }

  /**
   * Shut down the launcher gracefully.
   */
  async shutdown(): Promise<void> {
    console.info(`${LOG_PREFIX} Shutting down launcher...`);

    // Stop IPC heartbeat
    if (this._ipcHeartbeat) {
      try {
        this._ipcHeartbeat.stop();
      } catch (err) {
        console.warn(`${LOG_PREFIX} Error stopping heartbeat:`, err);
      }
    }

    // Stop daemon sidecar
    if (this._daemonSidecar) {
      try {
        await this._daemonSidecar.stop();
      } catch (err) {
        console.warn(`${LOG_PREFIX} Error stopping daemon:`, err);
      }
    }

    // Close updater logs
    if (this._updaterHealthCheck) {
      try {
        await this._updaterHealthCheck.closeLogging();
      } catch (err) {
        console.warn(`${LOG_PREFIX} Error closing updater logs:`, err);
      }
    }

    console.info(`${LOG_PREFIX} Launcher shutdown complete.`);
  }

  // ================================================================
  // Private: Initialization
  // ================================================================

  /** Initialize module instances and the lifecycle manager. */
  private _initModules(): void {
    this._coldStartOptimizer = new ColdStartOptimizer(
      PathUtils.normalize(this._config.appPath),
    );

    this._updaterHealthCheck = new UpdaterHealthCheck({
      currentAsarPath: PathUtils.normalize(this._config.asarPath),
      backupAsarPath: PathUtils.normalize(this._config.asarPath + ".backup"),
      logDir: PathUtils.normalize(this._config.logDir),
    });

    this._daemonSidecar = new SidecarManager(this._config.daemon);

    this._lifecycle = new WindowsLifecycle(this._fsm, {
      dbPath: PathUtils.normalize(this._config.dbPath),
      appPath: PathUtils.normalize(this._config.appPath),
      asarPath: PathUtils.normalize(this._config.asarPath),
    });

    // Wire modules to lifecycle
    if (this._gpuDetector) this._lifecycle.setGpuDetector(this._gpuDetector);
    if (this._coldStartOptimizer)
      this._lifecycle.setColdStartOptimizer(this._coldStartOptimizer);
    if (this._updaterHealthCheck)
      this._lifecycle.setUpdaterHealthCheck(this._updaterHealthCheck);
  }

  /** Register listeners for terminal states on the FSM. */
  private _registerStateListeners(): void {
    // Resolve ready promise when reaching terminal states
    this._fsm.once(StartupState.ROUTE_STABLE, () => {
      console.info(`${LOG_PREFIX} App reached ROUTE_STABLE.`);
      this._onStable();
    });

    this._fsm.once(StartupState.DAEMON_FAILED, (transition: StartupTransition) => {
      console.error(
        `${LOG_PREFIX} DAEMON_FAILED:`,
        transition.metadata,
      );
      this._readyResolve(StartupState.DAEMON_FAILED);
    });

    this._fsm.once(StartupState.WINDOW_FAILED, (transition: StartupTransition) => {
      console.error(
        `${LOG_PREFIX} WINDOW_FAILED:`,
        transition.metadata,
      );
      this._readyResolve(StartupState.WINDOW_FAILED);
    });
  }

  // ================================================================
  // Private: Startup Sequence
  // ================================================================

  /** Execute the full startup sequence. */
  private async _executeStartupSequence(): Promise<void> {
    // Ensure logging is initialized
    if (this._updaterHealthCheck) {
      await this._updaterHealthCheck.initLogging();
    }

    // Step 1: GPU Detection (LAUNCHER_STARTING)
    await this._stepGpuDetection();

    // Step 2: Start Daemon (DAEMON_STARTING → DAEMON_READY)
    await this._stepStartDaemon();

    // Step 3: Create Window (WINDOW_CREATING → WINDOW_READY)
    await this._stepCreateWindow();

    // Step 4: Route Init (ROUTE_INIT → ROUTE_STABLE)
    await this._stepRouteInit();
  }

  /** Step 1: LAUNCHER_STARTING — GPU detection. */
  private async _stepGpuDetection(): Promise<void> {
    this._fsm.transition(StartupState.LAUNCHER_STARTING);

    if (this._gpuDetector) {
      this._gpuCapability = await this._gpuDetector.detect();
      this._gpuDetector.applySwitches(this._gpuCapability);

      console.info(
        `${LOG_PREFIX} GPU: tier=${this._gpuCapability.tier}, ` +
          `vendor=${this._gpuCapability.vendor}`,
      );
    }
  }

  /** Step 2: DAEMON_STARTING → DAEMON_READY — Start daemon sidecar. */
  private async _stepStartDaemon(): Promise<void> {
    this._fsm.transition(StartupState.DAEMON_STARTING);

    if (!this._daemonSidecar) {
      throw new Error("Daemon sidecar not initialized.");
    }

    // Create daemon PING function for heartbeat
    const pingFn = async (): Promise<void> => {
      const response = await fetch(this._config.daemon.healthUrl, {
        method: "GET",
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        throw new Error(`Daemon health check failed: ${response.status}`);
      }
    };

    try {
      const daemonPid: number = await this._daemonSidecar.start(pingFn);

      // Get the heartbeat instance for lifecycle wiring
      this._ipcHeartbeat = this._daemonSidecar.getHeartbeat();
      if (this._ipcHeartbeat && this._lifecycle) {
        this._lifecycle.setIpcHeartbeat(this._ipcHeartbeat);
      }

      this._fsm.transition(StartupState.DAEMON_READY, { daemonPid });

      console.info(
        `${LOG_PREFIX} Daemon started (PID: ${daemonPid})`,
      );
    } catch (err) {
      console.error(`${LOG_PREFIX} Daemon start failed:`, err);
      this._fsm.transition(StartupState.DAEMON_FAILED, {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /** Step 3: WINDOW_CREATING → WINDOW_READY — Prepare window creation. */
  private async _stepCreateWindow(): Promise<void> {
    this._fsm.transition(StartupState.WINDOW_CREATING, {
      gpuSwitches: this._gpuCapability?.recommendedSwitches ?? [],
    });

    // The actual BrowserWindow creation is handled by the Electron main process.
    // This launcher marks the state; the main process reads it to configure the window.
    this._fsm.transition(StartupState.WINDOW_READY);
  }

  /** Step 4: ROUTE_INIT → ROUTE_STABLE — Renderer initialization. */
  private async _stepRouteInit(): Promise<void> {
    this._fsm.transition(StartupState.ROUTE_INIT);

    // The renderer (Next.js) signals when routing is stable.
    // In a real app, this would be an IPC event from the renderer.
    // For now, we simulate the transition:
    this._fsm.transition(StartupState.ROUTE_STABLE);

    console.info(
      `${LOG_PREFIX} Startup sequence complete (${this._fsm.getElapsedMs()}ms).`,
    );
  }

  // ================================================================
  // Private: Post-startup
  // ================================================================

  /** Called when the app reaches ROUTE_STABLE. */
  private _onStable(): void {
    // Configure deferred loading
    if (this._coldStartOptimizer) {
      this._lazyLoadConfig = this._coldStartOptimizer.configureLazyLoading();
      this._scheduleDeferredLoading();
    }

    // Schedule async update health check
    this._scheduleUpdateHealthCheck();

    // Resolve ready promise
    this._readyResolve(StartupState.ROUTE_STABLE);
  }

  /** Schedule deferred loading of non-critical modules. */
  private _scheduleDeferredLoading(): void {
    if (!this._lazyLoadConfig) return;

    const { telemetryDelay, pluginSystemDelay } = this._lazyLoadConfig;

    setTimeout(() => {
      console.info(`${LOG_PREFIX} Deferred: loading telemetry...`);
    }, telemetryDelay);

    setTimeout(() => {
      console.info(`${LOG_PREFIX} Deferred: loading plugin system...`);
    }, pluginSystemDelay);
  }

  /** Schedule the post-startup update health check. */
  private _scheduleUpdateHealthCheck(): void {
    if (!this._updaterHealthCheck) return;

    setTimeout(() => {
      this._updaterHealthCheck!
        .isHealthy()
        .then((healthy: boolean) => {
          console.info(
            `${LOG_PREFIX} Update health check: ${healthy ? "PASSED" : "FAILED"}`,
          );
          if (!healthy) {
            console.warn(
              `${LOG_PREFIX} Update health check found issues. Consider rollback.`,
            );
          }
        })
        .catch((err: unknown) => {
          console.warn(
            `${LOG_PREFIX} Update health check error:`,
            err instanceof Error ? err.message : err,
          );
        });
    }, 3_000);
  }

  // ================================================================
  // Private: Error handling
  // ================================================================

  /** Handle unexpected errors during startup. */
  private _handleStartupError(err: unknown): void {
    const message: string =
      err instanceof Error ? err.message : String(err);

    console.error(`${LOG_PREFIX} Startup error: ${message}`);

    try {
      const currentState = this._fsm.getCurrentState();
      if (
        currentState === StartupState.DAEMON_STARTING ||
        currentState === StartupState.LAUNCHER_STARTING
      ) {
        this._fsm.transition(StartupState.DAEMON_FAILED, { error: message });
      } else {
        this._fsm.transition(StartupState.WINDOW_FAILED, { error: message });
      }
    } catch {
      // If we can't transition, resolve the ready promise with the error
      this._readyResolve(
        this._fsm.getCurrentState() === StartupState.DAEMON_STARTING
          ? StartupState.DAEMON_FAILED
          : StartupState.WINDOW_FAILED,
      );
    }
  }
}

export default LauncherRuntime;
