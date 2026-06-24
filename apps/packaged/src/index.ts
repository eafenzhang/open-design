/**
 * Open Design — Main Entry Point (Windows-Optimized)
 *
 * This is the primary entry point for the packaged Electron application.
 * It creates all module instances, orchestrates the startup lifecycle
 * through the StartupStateMachine, and integrates GPU detection,
 * IPC heartbeat, cold start optimization, update health checks,
 * performance monitoring, and IPC compression.
 *
 * Startup flow:
 *   1. GPU detection → apply Chromium switches
 *   2. Start daemon sidecar
 *   3. SQLite warmup + Defender exclusion
 *   4. IPC heartbeat start
 *   5. Performance monitor init + Event Loop Monitor start
 *   6. Create BrowserWindow with GPU config + frameless title bar
 *   7. Load Next.js renderer
 *   8. FPS collection start + Deferred loading of non-critical modules
 *   9. Async update health check
 *
 * @module index
 */

import { app, BrowserWindow, ipcMain } from "electron";
import * as path from "node:path";

import { StartupStateMachine } from "./startup-state-machine.js";
import { StartupState } from "./types/startup-state.js";
import { GpuDetector } from "./gpu-detector.js";
import type { GpuCapability } from "./types/gpu-capability.js";
import { IpcHeartbeat } from "./ipc-heartbeat.js";
import { WindowsLifecycle } from "./windows-lifecycle.js";
import { ColdStartOptimizer } from "./cold-start-optimizer.js";
import { UpdaterHealthCheck } from "./updater-health-check.js";
import { SidecarManager } from "./sidecars.js";
import type { SidecarConfig } from "./sidecars.js";
import { PathUtils } from "./path-utils.js";
import { PerformanceMonitor } from "./performance-monitor.js";
import { IpcCompression } from "./ipc-compression.js";
import type { ElectronAppProxy } from "./gpu-detector.js";
import {
  WINDOW_IPC_CHANNELS,
  PERF_IPC_CHANNELS,
} from "./types/performance-metrics.js";
import type { PerformanceSnapshot } from "./types/performance-metrics.js";

/** Log prefix for this module. */
const LOG_PREFIX = "[OpenDesign:Index]";

/** Application configuration. */
interface AppConfig {
  /** Path to the SQLite database. */
  dbPath: string;

  /** Path to the app.asar. */
  asarPath: string;

  /** Path to the application install directory. */
  appPath: string;

  /** Directory for application logs. */
  logDir: string;

  /** Daemon sidecar configuration. */
  daemonConfig: SidecarConfig;

  /** Path to the renderer (Next.js dev server or built output). */
  rendererUrl: string;

  /** Path to the preload script. */
  preloadPath: string;
}

/** Default configuration (overridden by environment). */
const DEFAULT_APP_CONFIG: AppConfig = {
  dbPath: "",
  asarPath: "",
  appPath: "",
  logDir: "",
  rendererUrl: "http://localhost:3000",
  preloadPath: "",
  daemonConfig: {
    name: "daemon",
    executablePath: "",
    args: [],
    healthUrl: "http://127.0.0.1:18924/health",
    startupTimeoutMs: 30_000,
    healthCheckTimeoutMs: 30_000,
  },
};

/**
 * Main application bootstrap.
 *
 * @param electronApp - Electron app instance (or proxy for testing).
 * @param config - Application configuration.
 */
export async function bootstrap(
  electronApp: ElectronAppProxy | null,
  config: Partial<AppConfig> = {},
): Promise<void> {
  const appConfig: AppConfig = { ...DEFAULT_APP_CONFIG, ...config };

  console.info(`${LOG_PREFIX} ========================================`);
  console.info(`${LOG_PREFIX} Open Design Windows Starting...`);
  console.info(`${LOG_PREFIX} ========================================`);

  // ================================================================
  // Create core instances
  // ================================================================

  // 1. Startup State Machine
  const fsm: StartupStateMachine = new StartupStateMachine();

  // 2. GPU Detector
  const gpuDetector: GpuDetector = new GpuDetector(electronApp);

  // 3. Cold Start Optimizer
  const coldStartOptimizer: ColdStartOptimizer = new ColdStartOptimizer(
    PathUtils.normalize(appConfig.appPath),
  );

  // 4. Updater Health Check
  const updaterHealthCheck: UpdaterHealthCheck = new UpdaterHealthCheck({
    currentAsarPath: PathUtils.normalize(appConfig.asarPath),
    backupAsarPath: PathUtils.normalize(appConfig.asarPath + ".backup"),
    logDir: PathUtils.normalize(appConfig.logDir),
  });

  await updaterHealthCheck.initLogging();

  // 5. Performance Monitor (main-process aggregator)
  // IPC handlers are registered explicitly below — do NOT auto-register
  const performanceMonitor: PerformanceMonitor = new PerformanceMonitor(
    undefined, // No auto-registration — we handle IPC explicitly
    // Send IPC events to renderer (via BrowserWindow.webContents)
    (channel: string, ...args: unknown[]) => {
      const win: BrowserWindow | null = BrowserWindow.getAllWindows()[0] ?? null;
      if (win && !win.isDestroyed()) {
        win.webContents.send(channel, ...args);
      }
    },
  );

  // 6. IPC Compression (transparent gzip for large payloads)
  const ipcCompression: IpcCompression = new IpcCompression();

  // 7. IPC Heartbeat (will be created after daemon is started)
  let ipcHeartbeat: IpcHeartbeat | null = null;

  // 8. Daemon Sidecar Manager
  const daemonSidecar: SidecarManager = new SidecarManager(
    appConfig.daemonConfig,
  );

  // 9. Windows Lifecycle Manager
  const lifecycle: WindowsLifecycle = new WindowsLifecycle(fsm, {
    dbPath: PathUtils.normalize(appConfig.dbPath),
    appPath: PathUtils.normalize(appConfig.appPath),
    asarPath: PathUtils.normalize(appConfig.asarPath),
    updateCheckDelayMs: 3_000,
  });

  lifecycle.setGpuDetector(gpuDetector);
  lifecycle.setColdStartOptimizer(coldStartOptimizer);
  lifecycle.setUpdaterHealthCheck(updaterHealthCheck);
  lifecycle.setPerformanceMonitor(performanceMonitor);

  // ================================================================
  // Register before-quit handler for cleanup
  // ================================================================

  const beforeShutdown = async (): Promise<void> => {
    console.info(`${LOG_PREFIX} Running before-shutdown cleanup...`);

    try {
      performanceMonitor.dispose();
    } catch (err) {
      console.warn(`${LOG_PREFIX} Error disposing performance monitor:`, err);
    }

    try {
      await daemonSidecar.dispose();
    } catch (err) {
      console.warn(`${LOG_PREFIX} Error disposing daemon sidecar:`, err);
    }

    try {
      await updaterHealthCheck.closeLogging();
    } catch (err) {
      console.warn(`${LOG_PREFIX} Error closing updater log:`, err);
    }

    console.info(`${LOG_PREFIX} Shutdown cleanup complete.`);
  };

  if (electronApp && "on" in electronApp) {
    (electronApp as unknown as Electron.App).on(
      "before-quit" as unknown as Parameters<Electron.App["on"]>[0],
      () => {
        beforeShutdown().catch((err: unknown) => {
          console.error(`${LOG_PREFIX} beforeShutdown error:`, err);
        });
      },
    );
  }

  // ================================================================
  // Startup Sequence
  // ================================================================

  try {
    // Phase 1: LAUNCHER_STARTING → GPU Detection
    fsm.transition(StartupState.LAUNCHER_STARTING);

    const gpuCapability: GpuCapability = await gpuDetector.detect();
    gpuDetector.applySwitches(gpuCapability);

    console.info(
      `${LOG_PREFIX} GPU: tier=${gpuCapability.tier}, ` +
        `vendor=${gpuCapability.vendor}, angle=${gpuCapability.angleBackend}`,
    );

    // Phase 2: DAEMON_STARTING → Spawn daemon
    fsm.transition(StartupState.DAEMON_STARTING);

    try {
      // Create ping function for daemon heartbeat
      const pingFn = async (): Promise<void> => {
        const response = await fetch(appConfig.daemonConfig.healthUrl, {
          method: "GET",
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) {
          throw new Error(`Daemon health check failed: ${response.status}`);
        }
      };

      const daemonPid: number = await daemonSidecar.start(pingFn);

      fsm.transition(StartupState.DAEMON_READY, {
        daemonPid,
        gpuCapability,
      });

      // Get the heartbeat instance from sidecar
      ipcHeartbeat = daemonSidecar.getHeartbeat();
      if (ipcHeartbeat) {
        lifecycle.setIpcHeartbeat(ipcHeartbeat);
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} Daemon failed to start:`, err);
      fsm.transition(StartupState.DAEMON_FAILED, {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // Phase 3: WINDOW_CREATING → Create BrowserWindow
    fsm.transition(StartupState.WINDOW_CREATING, {
      gpuSwitches: gpuCapability.recommendedSwitches,
    });

    // ================================================================
    // BrowserWindow Creation with frameless title bar config
    // ================================================================

    const preloadPath: string =
      appConfig.preloadPath ||
      path.join(__dirname, "preload.js");

    const mainWindow: BrowserWindow = new BrowserWindow({
      width: 1280,
      height: 800,
      minWidth: 800,
      minHeight: 600,
      frame: false,
      autoHideMenuBar: true,
      backgroundColor: "#1e1e1e",
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
      },
      show: false,
    });

    // Apply Mica material on Win11 (graceful degradation on Win10)
    try {
      // Win11 feature detection: setBackgroundMaterial is available
      // on Electron 15+ but 'mica' only works on Win11 22000+
      mainWindow.setBackgroundMaterial("mica");
      console.info(`${LOG_PREFIX} Mica material applied (Win11).`);
    } catch {
      console.warn(
        `${LOG_PREFIX} Mica material not supported. Using solid color fallback.`,
      );
      // Graceful degradation: solid background color already set
    }

    // Window control IPC handlers (frameless title bar integration)
    ipcMain.handle(WINDOW_IPC_CHANNELS.MINIMIZE, () => {
      mainWindow.minimize();
    });

    ipcMain.handle(WINDOW_IPC_CHANNELS.MAXIMIZE, () => {
      if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
      } else {
        mainWindow.maximize();
      }
    });

    ipcMain.handle(WINDOW_IPC_CHANNELS.CLOSE, () => {
      mainWindow.close();
    });

    ipcMain.handle(WINDOW_IPC_CHANNELS.IS_MAXIMIZED, () => {
      return mainWindow.isMaximized();
    });

    ipcMain.handle(WINDOW_IPC_CHANNELS.SYSTEM_MENU, () => {
      // Popup the system menu at the top-left of the window
      // The position is relative to the window's content area
      const winBounds: Electron.Rectangle = mainWindow.getBounds();
      const contentBounds: Electron.Rectangle =
        mainWindow.getContentBounds();
      const titleBarHeight: number = winBounds.height - contentBounds.height;

      // Use the undocumented method to show the system menu
      // This triggers Windows to show the standard window menu
      try {
        const electronWindow = mainWindow as unknown as {
          _getSystemContextMenu?: () => Electron.Menu;
          showSystemMenu?: () => void;
        };

        if (typeof electronWindow.showSystemMenu === "function") {
          electronWindow.showSystemMenu();
        } else {
          // Fallback: simulate via IPC — send to renderer
          console.debug(
            `${LOG_PREFIX} System menu requested (not directly available).`,
          );
        }
      } catch {
        console.warn(`${LOG_PREFIX} Could not display system menu.`);
      }
    });

    // Forward maximize/unmaximize events to renderer
    mainWindow.on("maximize", () => {
      mainWindow.webContents.send(WINDOW_IPC_CHANNELS.MAXIMIZE_CHANGE, true);
    });

    mainWindow.on("unmaximize", () => {
      mainWindow.webContents.send(WINDOW_IPC_CHANNELS.MAXIMIZE_CHANGE, false);
    });

    // Performance IPC: FPS snapshot + Memory snapshot handlers
    // Wrapped with IPC compression for large payloads (>64KB gzip, transparent)
    ipcMain.handle(
      PERF_IPC_CHANNELS.FPS_SNAPSHOT,
      ipcCompression.wrapHandlerWithDecompress(
        async (_event, snapshot: PerformanceSnapshot) => {
          performanceMonitor.recordFpsSnapshot(snapshot);
        },
      ),
    );

    // Performance IPC: Memory snapshot handler
    ipcMain.handle(
      PERF_IPC_CHANNELS.MEMORY_SNAPSHOT,
      (_event, memoryMB: number) => {
        const latestSnapshot: PerformanceSnapshot | null =
          performanceMonitor.getLatestSnapshot();
        if (latestSnapshot) {
          latestSnapshot.memoryMB = memoryMB;
        }
      },
    );

    // Performance IPC: Stats query handler
    ipcMain.handle(PERF_IPC_CHANNELS.PERF_STATS, () => {
      const samples = performanceMonitor.getEventLoopSamples();
      return samples.length > 0
        ? samples[samples.length - 1].lagMs
        : 0;
    });

    // Show window when ready
    mainWindow.once("ready-to-show", () => {
      mainWindow.show();
    });

    // Load renderer URL
    await mainWindow.loadURL(appConfig.rendererUrl);

    fsm.transition(StartupState.WINDOW_READY);

    // Phase 4: ROUTE_INIT → Load renderer
    fsm.transition(StartupState.ROUTE_INIT);

    // Phase 5: ROUTE_STABLE → Application fully loaded
    fsm.transition(StartupState.ROUTE_STABLE);

    // Phase 6: PERFORMANCE_READY → Performance monitoring active
    fsm.transition(StartupState.PERFORMANCE_READY);

    console.info(
      `${LOG_PREFIX} ========================================`,
    );
    console.info(
      `${LOG_PREFIX} Startup complete! (${fsm.getElapsedMs()}ms)`,
    );
    console.info(
      `${LOG_PREFIX} IPC Compression: ` +
        `compressed=${ipcCompression.getStats().totalCompressed}, ` +
        `decompressed=${ipcCompression.getStats().totalDecompressed}, ` +
        `bytesSaved=${ipcCompression.getStats().bytesSaved}`,
    );
    console.info(
      `${LOG_PREFIX} ========================================`,
    );

    // ================================================================
    // Post-startup: Deferred loading
    // ================================================================
    const lazyConfig = coldStartOptimizer.configureLazyLoading();

    // Defer telemetry
    setTimeout(() => {
      console.info(`${LOG_PREFIX} Loading telemetry module (deferred)...`);
      // Telemetry initialization would go here
    }, lazyConfig.telemetryDelay);

    // Defer plugin system
    setTimeout(() => {
      console.info(`${LOG_PREFIX} Loading plugin system (deferred)...`);
      // Plugin system initialization would go here
    }, lazyConfig.pluginSystemDelay);

    // Async update health check (non-blocking)
    setTimeout(() => {
      updaterHealthCheck
        .isHealthy()
        .then((healthy: boolean) => {
          console.info(
            `${LOG_PREFIX} Update health check: ${healthy ? "PASSED" : "FAILED"}`,
          );
        })
        .catch((err: unknown) => {
          console.warn(
            `${LOG_PREFIX} Update health check error:`,
            err instanceof Error ? err.message : err,
          );
        });
    }, 5_000);
  } catch (err) {
    console.error(`${LOG_PREFIX} Unexpected error during startup:`, err);

    // Attempt to transition to appropriate error state
    try {
      const currentState: StartupState = fsm.getCurrentState();
      if (
        currentState === StartupState.DAEMON_STARTING ||
        currentState === StartupState.LAUNCHER_STARTING
      ) {
        fsm.transition(StartupState.DAEMON_FAILED, {
          error: err instanceof Error ? err.message : String(err),
        });
      } else {
        fsm.transition(StartupState.WINDOW_FAILED, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } catch {
      console.error(`${LOG_PREFIX} Could not transition to error state.`);
    }
  }
}

/**
 * Graceful shutdown handler.
 */
export async function shutdown(
  daemonSidecar: SidecarManager,
  updaterHealthCheck: UpdaterHealthCheck,
  performanceMonitor?: PerformanceMonitor,
): Promise<void> {
  console.info(`${LOG_PREFIX} Shutting down...`);

  if (performanceMonitor) {
    try {
      performanceMonitor.dispose();
    } catch (err) {
      console.warn(`${LOG_PREFIX} Error disposing performance monitor:`, err);
    }
  }

  try {
    await daemonSidecar.dispose();
  } catch (err) {
    console.warn(`${LOG_PREFIX} Error disposing daemon:`, err);
  }

  try {
    await updaterHealthCheck.closeLogging();
  } catch (err) {
    console.warn(`${LOG_PREFIX} Error closing updater log:`, err);
  }

  console.info(`${LOG_PREFIX} Shutdown complete.`);
}

// Default export for Electron app entry point
export default bootstrap;
