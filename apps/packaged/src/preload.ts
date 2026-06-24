/**
 * Open Design — Preload Script
 *
 * Exposes a controlled API from the Electron main process to the
 * renderer via contextBridge. Two namespaces are exposed:
 *
 *   windowControl — minimize, maximize, close, system menu, maximize state
 *   performance   — FPS snapshot reporting, event loop lag, perf warnings
 *
 * All IPC calls use ipcRenderer.invoke (request/response) or
 * ipcRenderer.on (event push from main).
 *
 * @module preload
 */

import { contextBridge, ipcRenderer } from "electron";
import {
  WINDOW_IPC_CHANNELS,
  PERF_IPC_CHANNELS,
} from "./types/performance-metrics.js";
import type {
  PerformanceSnapshot,
  PerfWarning,
} from "./types/performance-metrics.js";

// ------------------------------------------------------------------
// Window Control Namespace
// ------------------------------------------------------------------

const windowControl = {
  /** Minimize the application window. */
  minimize: (): Promise<void> =>
    ipcRenderer.invoke(WINDOW_IPC_CHANNELS.MINIMIZE),

  /** Maximize or restore the application window. */
  maximize: (): Promise<void> =>
    ipcRenderer.invoke(WINDOW_IPC_CHANNELS.MAXIMIZE),

  /** Close the application window. */
  close: (): Promise<void> =>
    ipcRenderer.invoke(WINDOW_IPC_CHANNELS.CLOSE),

  /** Query whether the window is currently maximized. */
  isMaximized: (): Promise<boolean> =>
    ipcRenderer.invoke(WINDOW_IPC_CHANNELS.IS_MAXIMIZED),

  /** Show the system (application) context menu. */
  systemMenu: (): Promise<void> =>
    ipcRenderer.invoke(WINDOW_IPC_CHANNELS.SYSTEM_MENU),

  /**
   * Listen for maximize/unmaximize state changes.
   *
   * @param callback - Called with true when maximized, false when restored.
   * @returns A cleanup function to remove the listener.
   */
  onMaximizeChange: (
    callback: (isMaximized: boolean) => void,
  ): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, isMaximized: boolean): void => {
      callback(isMaximized);
    };
    ipcRenderer.on(WINDOW_IPC_CHANNELS.MAXIMIZE_CHANGE, handler);
    return () => {
      ipcRenderer.removeListener(WINDOW_IPC_CHANNELS.MAXIMIZE_CHANGE, handler);
    };
  },
} as const;

// ------------------------------------------------------------------
// Performance Namespace
// ------------------------------------------------------------------

const performance = {
  /**
   * Send an FPS snapshot from the renderer to the main process.
   * Called every 1 second by the renderer's requestAnimationFrame counter.
   *
   * @param fps - The current FPS measurement.
   * @param memoryMB - Optional memory usage in MB.
   */
  fpsSnapshot: (fps: number, memoryMB?: number): Promise<void> =>
    ipcRenderer.invoke(PERF_IPC_CHANNELS.FPS_SNAPSHOT, {
      fps,
      timestamp: new Date().toISOString(),
      eventLoopLagMs: 0, // filled by main process
      memoryMB: memoryMB ?? 0,
    } satisfies PerformanceSnapshot),

  /**
   * Get the current event loop lag from the main process.
   *
   * @returns The latest event loop lag measurement in ms.
   */
  eventLoopLag: (): Promise<number> =>
    ipcRenderer.invoke(PERF_IPC_CHANNELS.PERF_STATS),

  /**
   * Listen for performance warnings pushed from the main process.
   *
   * @param callback - Called when a performance threshold is breached.
   * @returns A cleanup function to remove the listener.
   */
  onPerfWarning: (
    callback: (warning: PerfWarning) => void,
  ): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, warning: PerfWarning): void => {
      callback(warning);
    };
    ipcRenderer.on(PERF_IPC_CHANNELS.PERF_WARNING, handler);
    return () => {
      ipcRenderer.removeListener(PERF_IPC_CHANNELS.PERF_WARNING, handler);
    };
  },
} as const;

// ------------------------------------------------------------------
// Expose API via contextBridge
// ------------------------------------------------------------------

export interface ElectronAPI {
  windowControl: typeof windowControl;
  performance: typeof performance;
}

contextBridge.exposeInMainWorld("electronAPI", {
  windowControl,
  performance,
} satisfies ElectronAPI);
