/**
 * Open Design — Path Types
 *
 * Type definitions for the path normalization module.
 * Provides types for path style classification and WSL path detection.
 *
 * @module types/path-types
 */

/** Path style classification. */
export enum PathStyle {
  /** Windows-style path using backslashes (e.g., C:\Users\foo). */
  WINDOWS = "WINDOWS",

  /** Unix-style path using forward slashes (e.g., /home/foo). */
  UNIX = "UNIX",

  /** WSL interop path (e.g., \\wsl$\Ubuntu\home\foo). */
  WSL = "WSL",

  /** UNC network path (e.g., \\server\share\file). */
  UNC = "UNC",

  /** Mixed-style path that cannot be cleanly classified. */
  MIXED = "MIXED",
}

/** Result of a path normalization operation. */
export interface NormalizeResult {
  /** The normalized path string. */
  normalized: string;

  /** The detected original path style. */
  originalStyle: PathStyle;

  /** Whether the path was changed during normalization. */
  wasModified: boolean;
}

/** WSL distribution information extracted from a WSL path. */
export interface WslPathInfo {
  /** The WSL distribution name (e.g., "Ubuntu", "Debian"). */
  distribution: string;

  /** The path within the WSL filesystem (Unix-style). */
  linuxPath: string;

  /** The resolved Windows path if conversion was possible. */
  windowsPath: string | null;
}

/** Options for path comparison. */
export interface PathCompareOptions {
  /** Whether to perform case-insensitive comparison (default: true on Windows). */
  caseInsensitive?: boolean;

  /** Whether to normalize paths before comparing (default: true). */
  normalize?: boolean;
}

/**
 * Result type for operations that may succeed or fail.
 * Used across the codebase for graceful error handling.
 */
export type Result<T, E = Error> =
  | { success: true; data: T }
  | { success: false; error: E };
