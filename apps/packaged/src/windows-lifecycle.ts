/**
 * Open Design — Windows Lifecycle Hooks
 *
 * Integrates the StartupStateMachine with platform-specific lifecycle hooks.
 * Each state transition triggers a corresponding lifecycle action:
 *
 *   DAEMON_READY   → SQLite warmup, Defender exclusion
 *   WINDOW_CREATING → Apply GPU switches, create BrowserWindow
 *   ROUTE_STABLE   → Deferred loading of non-critical modules
 *
 * This module is specifically designed for the Windows platform.
 * It delegates to the appropriate modules based on the state transitions.
 *
 * @module windows-lifecycle
 */

import { StartupState } from "./types/startup-state.js";
import type { StartupStateMachine } from "./startup-state-machine.js";
import type { GpuDetector } from "./gpu-detector.js";
import type { GpuCapability } from "./types/gpu-capability.js";
import type { ColdStartOptimizer } from "./cold-start-optimizer.js";
import type { IpcHeartbeat } from "./ipc-heartbeat.js";
import type { UpdaterHealthCheck } from "./updater-health-check.js";
import type { PerformanceMonitor } from "./performance-monitor.js";

/** Log prefix for this module. */
const LOG_PREFIX = "[OpenDesign:WindowsLifecycle]";

/** Configuration for Windows lifecycle hooks. */
export interface WindowsLifecycleConfig {
  /** Path to the SQLite database for warmup. */
  dbPath: string;

  /** Path to the application installation directory (for Defender exclusion). */
  appPath: string;

  /** Path to the current asar file (for update health checks). */
  asarPath: string;

  /** Delay before checking for updates after ROUTE_STABLE (ms). */
  updateCheckDelayMs: number;
}

/** Default lifecycle configuration. */
const DEFAULT_CONFIG: WindowsLifecycleConfig = {
  dbPath: "",
  appPath: "",
  asarPath: "",
  updateCheckDelayMs: 3_000,
};

/**
 * Manages Windows-specific lifecycle actions triggered by
 * StartupStateMachine state transitions.
 *
 * Each state transition maps to specific platform operations:
 * - GPU detection: LAUNCHER_STARTING
 * - SQLite warmup: DAEMON_READY
 * - Defender exclusion: DAEMON_READY
 * - IPC heartbeat start: DAEMON_READY
 * - Window creation with GPU: WINDOW_CREATING
 * - Deferred module loading: ROUTE_STABLE
 * - Update health check: ROUTE_STABLE
 */
export class WindowsLifecycle {
  private readonly _config: WindowsLifecycleConfig;
  private readonly _fsm: StartupStateMachine;
  private _gpuDetector: GpuDetector | null;
  private _ipcHeartbeat: IpcHeartbeat | null;
  private _coldStartOptimizer: ColdStartOptimizer | null;
  private _updaterHealthCheck: UpdaterHealthCheck | null;
  private _performanceMonitor: PerformanceMonitor | null;
  private _gpuCapability: GpuCapability | null;

  constructor(
    fsm: StartupStateMachine,
    config: Partial<WindowsLifecycleConfig> = {},
  ) {
    this._config = { ...DEFAULT_CONFIG, ...config };
    this._fsm = fsm;
    this._gpuDetector = null;
    this._ipcHeartbeat = null;
    this._coldStartOptimizer = null;
    this._updaterHealthCheck = null;
    this._performanceMonitor = null;
    this._gpuCapability = null;

    this._registerHooks();
  }

  /**
   * Set the GpuDetector instance (called after it's created).
   */
  setGpuDetector(detector: GpuDetector): void {
    this._gpuDetector = detector;
  }

  /**
   * Set the IpcHeartbeat instance.
   */
  setIpcHeartbeat(heartbeat: IpcHeartbeat): void {
    this._ipcHeartbeat = heartbeat;
  }

  /**
   * Set the ColdStartOptimizer instance.
   */
  setColdStartOptimizer(optimizer: ColdStartOptimizer): void {
    this._coldStartOptimizer = optimizer;
  }

  /**
   * Set the UpdaterHealthCheck instance.
   */
  setUpdaterHealthCheck(updater: UpdaterHealthCheck): void {
    this._updaterHealthCheck = updater;
  }

  /**
   * Set the PerformanceMonitor instance.
   */
  setPerformanceMonitor(monitor: PerformanceMonitor): void {
    this._performanceMonitor = monitor;
  }

  /**
   * Get the cached GPU capability result.
   */
  getGpuCapability(): GpuCapability | null {
    return this._gpuCapability;
  }

  // ================================================================
  // Private: Hook registration
  // ================================================================

  /** Register lifecycle hooks on the state machine. */
  private _registerHooks(): void {
    this._fsm.on(StartupState.LAUNCHER_STARTING, () => {
      this._onLauncherStarting();
    });

    this._fsm.on(StartupState.DAEMON_STARTING, () => {
      this._onDaemonStarting();
    });

    this._fsm.on(StartupState.DAEMON_READY, () => {
      this._onDaemonReady();
    });

    this._fsm.on(StartupState.WINDOW_CREATING, () => {
      this._onWindowCreating();
    });

    this._fsm.on(StartupState.ROUTE_STABLE, () => {
      this._onRouteStable();
    });

    this._fsm.on(StartupState.DAEMON_FAILED, () => {
      this._onDaemonFailed();
    });

    this._fsm.on(StartupState.WINDOW_FAILED, () => {
      this._onWindowFailed();
    });
  }

  // ================================================================
  // Private: Lifecycle hooks
  // ================================================================

  /** Hook: LAUNCHER_STARTING — GPU detection runs here. */
  private async _onLauncherStarting(): Promise<void> {
    console.info(`${LOG_PREFIX} LAUNCHER_STARTING: Running GPU detection...`);

    if (this._gpuDetector) {
      try {
        this._gpuCapability = await this._gpuDetector.detect();
        this._gpuDetector.applySwitches(this._gpuCapability);
      } catch (err) {
        console.error(
          `${LOG_PREFIX} GPU detection failed:`,
          err,
        );
        // Graceful degradation: continue without GPU optimization
      }
    }
  }

  /** Hook: DAEMON_STARTING — Daemon process spawn preparation. */
  private _onDaemonStarting(): void {
    console.info(
      `${LOG_PREFIX} DAEMON_STARTING: Preparing daemon process spawn...`,
    );
    // Daemon spawning is handled by LauncherRuntime.
    // This hook can be used for pre-spawn setup if needed.
  }

  /** Hook: DAEMON_READY — SQLite warmup, Defender exclusion, IPC heartbeat, Event Loop Monitor. */
  private async _onDaemonReady(): Promise<void> {
    console.info(
      `${LOG_PREFIX} DAEMON_READY: Performing post-daemon initialization...`,
    );

    // SQLite warmup (non-critical — graceful degradation)
    if (this._coldStartOptimizer && this._config.dbPath) {
      try {
        await this._coldStartOptimizer.warmupSQLite(this._config.dbPath);
      } catch (err) {
        console.warn(
          `${LOG_PREFIX} SQLite warmup failed (non-critical):`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    // Defender exclusion (non-critical — requires admin, may fail)
    if (this._coldStartOptimizer && this._config.appPath) {
      try {
        await this._coldStartOptimizer.addDefenderExclusion(
          this._config.appPath,
        );
      } catch (err) {
        console.warn(
          `${LOG_PREFIX} Defender exclusion failed (non-critical):`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    // IPC heartbeat start
    if (this._ipcHeartbeat) {
      try {
        this._ipcHeartbeat.start();
      } catch (err) {
        console.error(
          `${LOG_PREFIX} IPC heartbeat start failed:`,
          err,
        );
      }
    }

    // Start event loop lag monitor on main process
    if (this._performanceMonitor) {
      try {
        this._performanceMonitor.startEventLoopMonitor();
        console.info(
          `${LOG_PREFIX} Event loop monitor started on DAEMON_READY.`,
        );
      } catch (err) {
        console.warn(
          `${LOG_PREFIX} Event loop monitor start failed (non-critical):`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  /** Hook: WINDOW_CREATING — Apply GPU configuration before window creation. */
  private _onWindowCreating(): void {
    console.info(
      `${LOG_PREFIX} WINDOW_CREATING: GPU capability applied.`,
    );

    if (this._gpuCapability) {
      console.info(
        `${LOG_PREFIX} GPU tier: ${this._gpuCapability.tier}, ` +
          `switches: [${this._gpuCapability.recommendedSwitches.join(", ")}]`,
      );
    }
    // Actual BrowserWindow creation is handled by LauncherRuntime
  }

  /** Hook: ROUTE_STABLE — Deferred loading, update check, and FPS collection start. */
  private _onRouteStable(): void {
    console.info(
      `${LOG_PREFIX} ROUTE_STABLE: Application fully loaded.`,
    );

    // Start FPS collection after route is stable (renderer ready)
    if (this._performanceMonitor) {
      try {
        this._performanceMonitor.startFpsCollection();
        console.info(
          `${LOG_PREFIX} FPS collection started on ROUTE_STABLE.`,
        );
      } catch (err) {
        console.warn(
          `${LOG_PREFIX} FPS collection start failed (non-critical):`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    // Defer update health check (async, non-blocking)
    if (this._updaterHealthCheck) {
      setTimeout(() => {
        this._updaterHealthCheck!
          .isHealthy()
          .then((healthy: boolean) => {
            if (!healthy) {
              console.warn(
                `${LOG_PREFIX} Update health check indicates issues.`,
              );
            } else {
              console.info(
                `${LOG_PREFIX} Update health check passed.`,
              );
            }
          })
          .catch((err: unknown) => {
            console.warn(
              `${LOG_PREFIX} Update health check failed:`,
              err instanceof Error ? err.message : err,
            );
          });
      }, this._config.updateCheckDelayMs);
    }
  }

  /** Hook: DAEMON_FAILED — Error handling for daemon failure. */
  private _onDaemonFailed(): void {
    console.error(
      `${LOG_PREFIX} DAEMON_FAILED: Daemon process failed. ` +
        `Application cannot start properly.`,
    );

    if (this._ipcHeartbeat) {
      try {
        this._ipcHeartbeat.stop();
      } catch {
        // Ignore stop errors in error path
      }
    }
  }

  /** Hook: WINDOW_FAILED — Error handling for window creation failure. */
  private _onWindowFailed(): void {
    console.error(
      `${LOG_PREFIX} WINDOW_FAILED: Window creation failed.`,
    );

    if (this._ipcHeartbeat) {
      try {
        this._ipcHeartbeat.stop();
      } catch {
        // Ignore stop errors in error path
      }
    }
  }
}

export default WindowsLifecycle;
