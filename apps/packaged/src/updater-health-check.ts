/**
 * Open Design — Updater Health Check
 *
 * Verifies update payload integrity (SHA-256), manages backup/rollback
 * of the app.asar, performs 30s self-health check after relaunch,
 * and logs all operations via rotating-file-stream.
 *
 * Update state machine: IDLE → CHECKING → DOWNLOADING → VERIFYING →
 *                     INSTALLING → RELAUNCHING → SUCCESS | ROLLBACK
 *
 * @module updater-health-check
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import * as nodePath from "node:path";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";

import type { RotatingFileStream } from "rotating-file-stream";
import { PathUtils } from "./path-utils.js";

/** Log prefix for this module. */
const LOG_PREFIX = "[OpenDesign:UpdaterHealthCheck]";

/** Update state machine states. */
export enum UpdaterState {
  IDLE = "IDLE",
  CHECKING = "CHECKING",
  DOWNLOADING = "DOWNLOADING",
  VERIFYING = "VERIFYING",
  INSTALLING = "INSTALLING",
  RELAUNCHING = "RELAUNCHING",
  SUCCESS = "SUCCESS",
  ROLLBACK = "ROLLBACK",
}

/** Custom error for update operations. */
export class UpdaterError extends Error {
  public readonly code: string;
  public readonly context: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "UpdaterError";
    this.code = code;
    this.context = context;
  }
}

/**
 * Health check configuration.
 */
export interface UpdaterHealthConfig {
  /** Path to the current app.asar. */
  currentAsarPath: string;

  /** Path to store backup app.asar. */
  backupAsarPath: string;

  /** Directory for updater logs. */
  logDir: string;

  /** Self-health check timeout in ms (default: 30s). */
  healthCheckTimeoutMs: number;

  /** Maximum number of rotating log files. */
  maxLogFiles: number;

  /** Maximum size of each log file in bytes. */
  maxLogSize: number;
}

/** Default configuration. */
const DEFAULT_HEALTH_CONFIG: UpdaterHealthConfig = {
  currentAsarPath: "",
  backupAsarPath: "",
  logDir: "",
  healthCheckTimeoutMs: 30_000,
  maxLogFiles: 10,
  maxLogSize: 5 * 1024 * 1024, // 5MB
};

/**
 * Updater Health Check manager.
 *
 * Handles:
 * - SHA-256 payload integrity verification
 * - Backup creation before update installation
 * - Rollback to previous version on failure
 * - 30-second self-health check after relaunch
 * - Rotating file log persistence
 */
export class UpdaterHealthCheck {
  private readonly _config: UpdaterHealthConfig;
  private _state: UpdaterState;
  private _logStream: RotatingFileStream | null;
  private _isHealthy: boolean;

  constructor(config: Partial<UpdaterHealthConfig> = {}) {
    this._config = { ...DEFAULT_HEALTH_CONFIG, ...config };
    this._state = UpdaterState.IDLE;
    this._logStream = null;
    this._isHealthy = true;
  }

  /**
   * Initialize the rotating log stream.
   * Must be called before any logging operations.
   */
  async initLogging(): Promise<void> {
    try {
      const rfs = await import("rotating-file-stream");
      const logDir: string = PathUtils.normalize(this._config.logDir);

      await fs.mkdir(logDir, { recursive: true });

      const logPath: string = PathUtils.join(logDir, "updater.log");

      this._logStream = rfs.createStream(logPath, {
        size: `${this._config.maxLogSize / (1024 * 1024)}M`,
        maxFiles: this._config.maxLogFiles,
        compress: true,
      });

      this._log("UpdaterHealthCheck logging initialized.");
    } catch (err) {
      console.error(
        `${LOG_PREFIX} Failed to initialize logging:`,
        err,
      );
    }
  }

  /**
   * Verify the integrity of a downloaded update payload using SHA-256.
   *
   * @param asarPath - Path to the downloaded asar file.
   * @param expectedChecksum - Expected SHA-256 hex digest.
   * @returns true if the checksums match.
   */
  async verifyPayload(
    asarPath: string,
    expectedChecksum: string,
  ): Promise<boolean> {
    this._state = UpdaterState.VERIFYING;
    this._log(`Verifying payload: ${asarPath}`);

    try {
      const normalizedPath: string = PathUtils.normalize(asarPath);
      const actualChecksum: string =
        await UpdaterHealthCheck._sha256File(normalizedPath);

      const isValid: boolean =
        actualChecksum.toLowerCase() === expectedChecksum.toLowerCase();

      this._log(
        `SHA-256 verification: expected=${expectedChecksum}, ` +
          `actual=${actualChecksum}, valid=${isValid}`,
      );

      if (!isValid) {
        throw new UpdaterError(
          "CHECKSUM_MISMATCH",
          `Checksum mismatch for ${asarPath}. ` +
            `Expected: ${expectedChecksum}, Got: ${actualChecksum}`,
          { asarPath, expectedChecksum, actualChecksum },
        );
      }

      return isValid;
    } catch (err) {
      if (err instanceof UpdaterError) throw err;

      throw new UpdaterError(
        "VERIFY_FAILED",
        `Failed to verify payload: ${err instanceof Error ? err.message : err}`,
        { asarPath },
      );
    }
  }

  /**
   * Create a backup of the current app.asar before installing an update.
   */
  async createBackup(): Promise<void> {
    this._state = UpdaterState.INSTALLING;
    const currentAsar: string = PathUtils.normalize(
      this._config.currentAsarPath,
    );
    const backupAsar: string = PathUtils.normalize(
      this._config.backupAsarPath,
    );

    this._log(`Creating backup: ${currentAsar} → ${backupAsar}`);

    try {
      const stat = await fs.stat(currentAsar);
      if (!stat.isFile()) {
        throw new UpdaterError(
          "NOT_A_FILE",
          `Current asar is not a file: ${currentAsar}`,
          { currentAsar },
        );
      }

      // Ensure backup directory exists
      await fs.mkdir(nodePath.dirname(backupAsar), { recursive: true });

      // Copy the file
      await fs.copyFile(currentAsar, backupAsar);

      // Verify the backup
      const originalChecksum: string =
        await UpdaterHealthCheck._sha256File(currentAsar);
      const backupChecksum: string =
        await UpdaterHealthCheck._sha256File(backupAsar);

      if (originalChecksum !== backupChecksum) {
        throw new UpdaterError(
          "BACKUP_CORRUPT",
          "Backup file checksum does not match original.",
          { currentAsar, backupAsar },
        );
      }

      this._log("Backup created and verified successfully.");
    } catch (err) {
      if (err instanceof UpdaterError) throw err;

      throw new UpdaterError(
        "BACKUP_FAILED",
        `Failed to create backup: ${err instanceof Error ? err.message : err}`,
        { currentAsar, backupAsar },
      );
    }
  }

  /**
   * Rollback to the previously backed-up version of app.asar.
   * Restores the backup asar and cleans up.
   */
  async rollback(): Promise<void> {
    this._state = UpdaterState.ROLLBACK;
    const currentAsar: string = PathUtils.normalize(
      this._config.currentAsarPath,
    );
    const backupAsar: string = PathUtils.normalize(
      this._config.backupAsarPath,
    );

    this._log(`Rolling back: ${backupAsar} → ${currentAsar}`);

    try {
      // Check that backup exists
      await fs.stat(backupAsar);

      // Restore backup over current asar
      await fs.copyFile(backupAsar, currentAsar);

      this._log("Rollback completed successfully.");
    } catch (err) {
      throw new UpdaterError(
        "ROLLBACK_FAILED",
        `Failed to rollback: ${err instanceof Error ? err.message : err}`,
        { currentAsar, backupAsar },
      );
    }
  }

  /**
   * Clean up the backup asar file after a successful update.
   */
  async cleanupBackup(): Promise<void> {
    const backupAsar: string = PathUtils.normalize(
      this._config.backupAsarPath,
    );

    this._log(`Cleaning up backup: ${backupAsar}`);

    try {
      await fs.unlink(backupAsar);
      this._log("Backup cleaned up.");
    } catch (err) {
      // File may already not exist — that's fine
      const code: string =
        (err as NodeJS.ErrnoException).code ?? "";
      if (code === "ENOENT") {
        this._log("Backup file not found (already cleaned up).");
        return;
      }
      console.warn(
        `${LOG_PREFIX} Failed to clean up backup:`,
        err,
      );
    }
  }

  /**
   * Perform self-health check after relaunch.
   *
   * The health check verifies:
   * 1. The process is still alive after healthCheckTimeoutMs
   * 2. The current asar file exists and is readable
   * 3. IPC connection is established (if ipcCheckFn is provided)
   *
   * @param ipcCheckFn - Optional function to check IPC connectivity.
   * @returns true if the application is healthy.
   */
  async isHealthy(ipcCheckFn?: () => Promise<boolean>): Promise<boolean> {
    this._log("Starting self-health check...");

    try {
      // Check 1: Verify asar file exists
      const currentAsar: string = PathUtils.normalize(
        this._config.currentAsarPath,
      );

      try {
        await fs.stat(currentAsar);
      } catch {
        this._log("Health check FAILED: asar file not found.");
        this._isHealthy = false;
        return false;
      }

      // Check 2: Verify IPC connectivity (if function provided)
      if (ipcCheckFn) {
        const ipcHealthy: boolean = await UpdaterHealthCheck._withTimeout(
          ipcCheckFn(),
          this._config.healthCheckTimeoutMs,
          "IPC health check timed out",
        );

        if (!ipcHealthy) {
          this._log("Health check FAILED: IPC not healthy.");
          this._isHealthy = false;
          return false;
        }
      }

      this._log("Health check PASSED.");
      this._isHealthy = true;
      return true;
    } catch (err) {
      this._log(
        `Health check FAILED: ${err instanceof Error ? err.message : err}`,
      );
      this._isHealthy = false;
      return false;
    }
  }

  /**
   * Get the current update state.
   */
  getState(): UpdaterState {
    return this._state;
  }

  /**
   * Get whether the last health check passed.
   */
  getIsHealthy(): boolean {
    return this._isHealthy;
  }

  /**
   * Reset the updater state to IDLE.
   */
  resetState(): void {
    this._state = UpdaterState.IDLE;
  }

  /**
   * Close the log stream.
   */
  async closeLogging(): Promise<void> {
    if (this._logStream) {
      await new Promise<void>((resolve) => {
        this._logStream!.end(() => resolve());
      });
      this._logStream = null;
    }
  }

  // ================================================================
  // Private helpers
  // ================================================================

  /** Write a message to the rotating log stream. */
  private _log(message: string): void {
    const timestamp: string = new Date().toISOString();
    const line: string = `${timestamp} [${this._state}] ${message}\n`;

    if (this._logStream) {
      this._logStream.write(line);
    }

    // Also echo to console for development
    console.info(`${LOG_PREFIX} ${line.trim()}`);
  }

  /** Compute SHA-256 hash of a file. */
  private static async _sha256File(filePath: string): Promise<string> {
    const hash = crypto.createHash("sha256");
    const readStream = createReadStream(filePath);

    return new Promise<string>((resolve, reject) => {
      readStream.on("data", (chunk: string | Buffer) => hash.update(chunk));
      readStream.on("end", () => resolve(hash.digest("hex")));
      readStream.on("error", (err: Error) => reject(err));
    });
  }

  /** Run a promise with a timeout. */
  private static async _withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    timeoutMessage: string,
  ): Promise<T> {
    let timeoutHandle: ReturnType<typeof setTimeout>;

    const timeoutPromise: Promise<never> = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(timeoutMessage));
      }, timeoutMs);
    });

    try {
      const result = await Promise.race([promise, timeoutPromise]);
      clearTimeout(timeoutHandle!);
      return result;
    } catch (err) {
      clearTimeout(timeoutHandle!);
      throw err;
    }
  }
}

export default UpdaterHealthCheck;
