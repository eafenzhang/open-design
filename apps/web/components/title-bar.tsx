/**
 * Open Design — Title Bar Container
 *
 * Custom frameless window title bar that replaces the native Windows
 * title bar. Integrates with electronAPI.windowControl for min/max/close
 * operations and system menu display.
 *
 * Features:
 * - Win10 (32px) / Win11 (36px) height auto-detection
 * - Full -webkit-app-region: drag for window dragging
 * - Maximize/Restore state tracking via onMaximizeChange
 * - System menu popup on icon click
 * - Dark/Light theme CSS variable support
 *
 * @module components/title-bar/title-bar
 */

import React, { useState, useEffect, useCallback } from "react";
import { TitleBarControls } from "./title-bar-controls.js";
import { TitleBarIcon } from "./title-bar-icon.js";
import { TitleBarTitle } from "./title-bar-title.js";
import styles from "./title-bar.module.css";

/** Props for the TitleBar component. */
export interface TitleBarProps {
  /** The window title text. */
  title?: string;

  /** Custom children to render in the title area. */
  children?: React.ReactNode;

  /** Whether to show the application icon. Default: true. */
  showIcon?: boolean;

  /** Whether to use the light theme. Default: false (dark). */
  lightTheme?: boolean;

  /** Whether to force Win10 sizing. Default: auto-detect. */
  forceWin10?: boolean;
}

/**
 * Custom title bar container component.
 *
 * Replaces the native Windows title bar in frameless mode.
 * Handles window state management and delegates control actions
 * to the Electron main process via electronAPI.
 */
export const TitleBar: React.FC<TitleBarProps> = ({
  title = "Open Design",
  children,
  showIcon = true,
  lightTheme = false,
  forceWin10 = false,
}) => {
  const [isMaximized, setIsMaximized] = useState<boolean>(false);
  const [isWin10, setIsWin10] = useState<boolean>(false);

  // Detect Windows version on mount
  useEffect(() => {
    detectWindowsVersion()
      .then((win10: boolean) => {
        setIsWin10(forceWin10 || win10);
      })
      .catch(() => {
        setIsWin10(forceWin10);
      });
  }, [forceWin10]);

  // Subscribe to maximize state changes from main process
  useEffect(() => {
    const electronAPI = getElectronAPI();

    if (!electronAPI?.windowControl?.onMaximizeChange) {
      return;
    }

    // Query initial state
    electronAPI.windowControl
      .isMaximized()
      .then((maximized: boolean) => {
        setIsMaximized(maximized);
      })
      .catch(() => {
        // Electron API not available (e.g., running in browser)
      });

    // Listen for changes
    const cleanup: (() => void) | undefined =
      electronAPI.windowControl.onMaximizeChange((maximized: boolean) => {
        setIsMaximized(maximized);
      });

    return () => {
      cleanup?.();
    };
  }, []);

  // Set CSS class on root for Win10/Win11 sizing and light/dark theme
  useEffect(() => {
    const root: HTMLElement = document.documentElement;

    if (isWin10) {
      root.classList.add("titleBar_win10");
    } else {
      root.classList.remove("titleBar_win10");
    }

    if (lightTheme) {
      root.classList.add("titleBar_light");
    } else {
      root.classList.remove("titleBar_light");
    }
  }, [isWin10, lightTheme]);

  // Window control handlers
  const handleMinimize = useCallback(() => {
    getElectronAPI()?.windowControl?.minimize();
  }, []);

  const handleMaximize = useCallback(() => {
    getElectronAPI()?.windowControl?.maximize();
  }, []);

  const handleClose = useCallback(() => {
    getElectronAPI()?.windowControl?.close();
  }, []);

  const handleSystemMenu = useCallback(() => {
    getElectronAPI()?.windowControl?.systemMenu();
  }, []);

  const handleContextMenu = useCallback(() => {
    // Right-click on icon shows the native system menu
    getElectronAPI()?.windowControl?.systemMenu();
  }, []);

  return (
    <div className={styles.titleBar_dragRegion}>
      {showIcon && (
        <TitleBarIcon
          onSystemMenu={handleSystemMenu}
          onContextMenu={handleContextMenu}
          ariaLabel={`${title} Menu`}
        />
      )}

      <TitleBarTitle title={title}>
        {children}
      </TitleBarTitle>

      <TitleBarControls
        isMaximized={isMaximized}
        onMinimize={handleMinimize}
        onMaximize={handleMaximize}
        onClose={handleClose}
      />
    </div>
  );
};

// ================================================================
// Helpers
// ================================================================

/**
 * Access the electronAPI exposed by preload.ts via contextBridge.
 * Returns undefined if not running in Electron (e.g., browser dev).
 */
function getElectronAPI(): ElectronAPI | undefined {
  if (typeof window !== "undefined" && "electronAPI" in window) {
    return (window as unknown as Record<string, ElectronAPI>).electronAPI;
  }
  return undefined;
}

/**
 * Detect Windows 10 vs Windows 11 by checking the user agent.
 *
 * Windows 10: NT 10.0, build < 22000
 * Windows 11: NT 10.0, build >= 22000
 *
 * @returns true if Windows 10 (32px title bar), false if Win11 (36px).
 */
async function detectWindowsVersion(): Promise<boolean> {
  // Try to use Electron's process to get OS version
  try {
    const electronAPI = getElectronAPI();
    if (electronAPI && typeof electronAPI === "object") {
      // The user agent on Win11 still reports "Windows NT 10.0"
      // but the build number is >= 22000
      const ua: string = navigator.userAgent;
      const match: RegExpMatchArray | null = ua.match(
        /Windows NT 10\.0[^;]*/,
      );
      if (match) {
        // Parse build number from navigator or fallback
        // Win11 builds start at 22000
        // We use a simple UA check as fallback
        try {
          // On Win11 via Electron, navigator.userAgentData is available
          if ("userAgentData" in navigator) {
            const uad = (
              navigator as Navigator & {
                userAgentData?: {
                  getHighEntropyValues: (
                    hints: string[],
                  ) => Promise<{ platformVersion: string }>;
                };
              }
            ).userAgentData;
            if (uad) {
              const entropy =
                await uad.getHighEntropyValues(["platformVersion"]);
              const versionParts: string[] =
                entropy.platformVersion.split(".");
              const major: number = parseInt(versionParts[0], 10);
              // Win11: major >= 13 or build >= 22000
              if (major >= 13) {
                return false; // Win11
              }
              const minor: number = parseInt(versionParts[1] ?? "0", 10);
              if (major === 10 && minor >= 22000) {
                return false; // Win11
              }
              return true; // Win10
            }
          }
        } catch {
          // userAgentData not available, fall through
        }
      }
    }
  } catch {
    // Running outside Electron, use UA
  }

  // Fallback: parse build from UA string
  const ua: string = navigator.userAgent;
  // Check for Electron (which bundles Chromium version)
  // Win11 Chrome/Electron versions are generally newer
  const chromeMatch: RegExpMatchArray | null = ua.match(
    /Chrome\/(\d+)\./,
  );
  if (chromeMatch) {
    const chromeVersion: number = parseInt(chromeMatch[1], 10);
    // Chromium 95+ roughly corresponds to Win11 era
    return chromeVersion < 95;
  }

  // Default: assume Win11 (36px)
  return false;
}

/** Type for the electronAPI exposed by preload.ts. */
interface ElectronAPI {
  windowControl: {
    minimize: () => Promise<void>;
    maximize: () => Promise<void>;
    close: () => Promise<void>;
    isMaximized: () => Promise<boolean>;
    systemMenu: () => Promise<void>;
    onMaximizeChange: (
      callback: (isMaximized: boolean) => void,
    ) => () => void;
  };
  performance: {
    fpsSnapshot: (fps: number, memoryMB?: number) => Promise<void>;
    eventLoopLag: () => Promise<number>;
    onPerfWarning: (
      callback: (warning: unknown) => void,
    ) => () => void;
  };
}

export default TitleBar;
