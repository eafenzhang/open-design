/**
 * Open Design — Windows Defender Utilities
 *
 * Manages Windows Defender exclusion list operations via PowerShell.
 * Adds/removes directory exclusions to reduce Defender scanning overhead
 * on application files (Electron app directory, SQLite database, logs).
 *
 * Operations require administrator privileges and will fail gracefully
 * (non-blocking) if not available.
 *
 * @module defender-utils
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PathUtils } from "./path-utils.js";
import type { Result } from "./types/path-types.js";

const execFileAsync = promisify(execFile);

/** Log prefix for this module. */
const LOG_PREFIX = "[OpenDesign:DefenderUtils]";

/** Defender real-time protection and exclusions status. */
export interface DefenderStatus {
  /** Whether real-time protection is enabled. */
  realTimeProtection: boolean;

  /** List of currently excluded paths. */
  excludedPaths: string[];
}

/** Custom error for Defender operations. */
export class DefenderError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DefenderError";
    this.code = code;
  }
}

/**
 * Utility class for managing Windows Defender exclusions.
 *
 * All methods are static and work exclusively on Windows platforms.
 * Operations require administrator privileges for write operations
 * (addExclusion, removeExclusion). Read operations (isExcluded,
 * checkDefenderStatus) work without elevation.
 */
export class DefenderUtils {
  /** PowerShell executable path. */
  private static readonly POWERSHELL: string = "powershell.exe";

  /** Timeout for PowerShell commands (ms). */
  private static readonly COMMAND_TIMEOUT_MS: number = 30_000;

  /**
   * Add a path to the Windows Defender exclusion list.
   *
   * Uses PowerShell: Add-MpPreference -ExclusionPath "<path>"
   *
   * @param path - The directory or file path to exclude.
   * @returns Result with true on success, error on failure.
   */
  static async addExclusion(path: string): Promise<Result<boolean>> {
    const normalizedPath: string = PathUtils.normalize(path);

    console.info(
      `${LOG_PREFIX} Adding Defender exclusion: ${normalizedPath}`,
    );

    try {
      const psCommand: string =
        `Add-MpPreference -ExclusionPath "${normalizedPath}"`;

      const { stderr } = await execFileAsync(
        DefenderUtils.POWERSHELL,
        ["-NoProfile", "-NonInteractive", "-Command", psCommand],
        { timeout: DefenderUtils.COMMAND_TIMEOUT_MS },
      );

      if (stderr && stderr.trim().length > 0) {
        console.warn(`${LOG_PREFIX} PowerShell stderr: ${stderr.trim()}`);
      }

      console.info(
        `${LOG_PREFIX} Successfully added exclusion: ${normalizedPath}`,
      );

      return { success: true, data: true };
    } catch (err) {
      const message: string =
        err instanceof Error ? err.message : String(err);

      console.warn(
        `${LOG_PREFIX} Failed to add exclusion (likely missing admin privileges): ${message}`,
      );

      return {
        success: false,
        error: new DefenderError(
          "ADD_EXCLUSION_FAILED",
          `Failed to add Defender exclusion: ${message}`,
        ),
      };
    }
  }

  /**
   * Remove a path from the Windows Defender exclusion list.
   *
   * Uses PowerShell: Remove-MpPreference -ExclusionPath "<path>"
   *
   * @param path - The directory or file path to remove from exclusions.
   * @returns Result with true on success, error on failure.
   */
  static async removeExclusion(path: string): Promise<Result<boolean>> {
    const normalizedPath: string = PathUtils.normalize(path);

    console.info(
      `${LOG_PREFIX} Removing Defender exclusion: ${normalizedPath}`,
    );

    try {
      const psCommand: string =
        `Remove-MpPreference -ExclusionPath "${normalizedPath}"`;

      const { stderr } = await execFileAsync(
        DefenderUtils.POWERSHELL,
        ["-NoProfile", "-NonInteractive", "-Command", psCommand],
        { timeout: DefenderUtils.COMMAND_TIMEOUT_MS },
      );

      if (stderr && stderr.trim().length > 0) {
        console.warn(`${LOG_PREFIX} PowerShell stderr: ${stderr.trim()}`);
      }

      console.info(
        `${LOG_PREFIX} Successfully removed exclusion: ${normalizedPath}`,
      );

      return { success: true, data: true };
    } catch (err) {
      const message: string =
        err instanceof Error ? err.message : String(err);

      return {
        success: false,
        error: new DefenderError(
          "REMOVE_EXCLUSION_FAILED",
          `Failed to remove Defender exclusion: ${message}`,
        ),
      };
    }
  }

  /**
   * Check if a path is currently in the Windows Defender exclusion list.
   *
   * @param path - The path to check.
   * @returns Result with true if excluded, false if not, or error.
   */
  static async isExcluded(path: string): Promise<Result<boolean>> {
    const normalizedPath: string = PathUtils.normalize(path);

    try {
      const psCommand: string =
        `(Get-MpPreference).ExclusionPath -contains "${normalizedPath}"`;

      const { stdout } = await execFileAsync(
        DefenderUtils.POWERSHELL,
        ["-NoProfile", "-NonInteractive", "-Command", psCommand],
        { timeout: DefenderUtils.COMMAND_TIMEOUT_MS },
      );

      const isExcluded: boolean =
        stdout.trim().toLowerCase() === "true";

      return { success: true, data: isExcluded };
    } catch (err) {
      const message: string =
        err instanceof Error ? err.message : String(err);

      return {
        success: false,
        error: new DefenderError(
          "CHECK_EXCLUSION_FAILED",
          `Failed to check Defender exclusion: ${message}`,
        ),
      };
    }
  }

  /**
   * Check the current Windows Defender status.
   *
   * Retrieves real-time protection status and list of excluded paths.
   *
   * @returns Result with DefenderStatus or error.
   */
  static async checkDefenderStatus(): Promise<Result<DefenderStatus>> {
    try {
      const psCommand: string = `
        $prefs = Get-MpPreference;
        $status = Get-MpComputerStatus;
        @{
          RealTimeProtection = $status.RealTimeProtectionEnabled;
          ExcludedPaths = @($prefs.ExclusionPath);
        } | ConvertTo-Json -Compress
      `;

      const { stdout } = await execFileAsync(
        DefenderUtils.POWERSHELL,
        ["-NoProfile", "-NonInteractive", "-Command", psCommand],
        { timeout: DefenderUtils.COMMAND_TIMEOUT_MS },
      );

      const parsed = JSON.parse(stdout.trim());

      const status: DefenderStatus = {
        realTimeProtection: parsed.RealTimeProtection === true,
        excludedPaths: Array.isArray(parsed.ExcludedPaths)
          ? parsed.ExcludedPaths
          : [],
      };

      console.info(
        `${LOG_PREFIX} Defender status: ` +
          `realTime=${status.realTimeProtection}, ` +
          `exclusions=${status.excludedPaths.length}`,
      );

      return { success: true, data: status };
    } catch (err) {
      const message: string =
        err instanceof Error ? err.message : String(err);

      return {
        success: false,
        error: new DefenderError(
          "STATUS_CHECK_FAILED",
          `Failed to check Defender status: ${message}`,
        ),
      };
    }
  }
}

export default DefenderUtils;
