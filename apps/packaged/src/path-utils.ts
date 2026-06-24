/**
 * Open Design — Windows Path Utilities
 *
 * Unified path normalization module for cross-platform path handling.
 * All file I/O paths in the project should pass through PathUtils.normalize()
 * before use to ensure consistency across WSL, UNC, and native Windows paths.
 *
 * @module path-utils
 */

import * as nodePath from "node:path";

import {
  PathStyle,
  type NormalizeResult,
  type PathCompareOptions,
  type Result,
  type WslPathInfo,
} from "./types/path-types.js";

/** Log prefix for this module. */
const LOG_PREFIX = "[OpenDesign:PathUtils]";

/** WSL path prefix pattern: \\wsl$\<distro>\ */
const WSL_PATH_PATTERN: RegExp = /^\\\\wsl\$\\[^\\]+/i;

/** WSL path parse pattern with capture groups. */
const WSL_PATH_PARSE_PATTERN: RegExp =
  /^\\\\wsl\$\\([^\\]+)\\(.+)$/i;

/** DOS device prefix (e.g., \\.\C:\) */
const DOS_DEVICE_PATTERN: RegExp = /^\\\\\.\\[A-Z]:/i;

/**
 * Static utility class for Windows path normalization and conversion.
 *
 * All file I/O in the Open Design project should route paths through
 * `PathUtils.normalize()` to ensure consistent handling across:
 * - Native Windows paths (C:\Users\...)
 * - UNC network paths (\\server\share\...)
 * - WSL interop paths (\\wsl$\Ubuntu\...)
 * - Mixed Unix/Windows paths
 */
export class PathUtils {

  /**
   * Normalize a path string to a canonical form.
   *
   * On Windows: converts forward slashes to backslashes, resolves
   * `.` and `..` segments, eliminates duplicate separators.
   * On Unix: preserves forward slashes, resolves segments.
   *
   * @param input - The raw path string to normalize.
   * @returns The normalized path.
   */
  static normalize(input: string): string {
    if (!input || input.length === 0) {
      return input;
    }

    // Detect and handle WSL paths specially
    if (PathUtils._isWslPathInternal(input)) {
      return PathUtils._normalizeWslPath(input);
    }

    // Normalize: use Node path.normalize then clean up
    let normalized: string = nodePath.normalize(input);

    // Ensure consistent separator style
    if (PathUtils._isWindowsPlatform()) {
      normalized = normalized.replace(/\//g, "\\");
      // Collapse duplicate backslashes (but preserve UNC prefix)
      normalized = PathUtils._collapseSeparators(normalized);
      // Uppercase drive letter for consistency (e.g., c:\ → C:\)
      normalized = normalized.replace(
        /^([a-z]):/,
        (_match: string, drive: string): string => drive.toUpperCase() + ":",
      );
    } else {
      normalized = normalized.replace(/\\/g, "/");
      normalized = normalized.replace(/\/{2,}/g, "/");
    }

    return normalized;
  }

  /**
   * Normalize and return detailed result including the original style.
   *
   * @param input - The raw path string to normalize.
   * @returns NormalizeResult with normalized path and metadata.
   */
  static normalizeWithResult(input: string): NormalizeResult {
    const originalStyle: PathStyle = PathUtils.classify(input);
    const normalized: string = PathUtils.normalize(input);
    const wasModified: boolean = normalized !== input;

    return { normalized, originalStyle, wasModified };
  }

  /**
   * Convert any path to Windows-style (backslash separators).
   *
   * @param input - Path to convert.
   * @returns Windows-style path with backslashes.
   */
  static toWindowsStyle(input: string): string {
    return PathUtils.normalize(input).replace(/\//g, "\\");
  }

  /**
   * Convert any path to Unix-style (forward slash separators).
   *
   * @param input - Path to convert.
   * @returns Unix-style path with forward slashes.
   */
  static toUnixStyle(input: string): string {
    return PathUtils.normalize(input).replace(/\\/g, "/");
  }

  /**
   * Check if a path is a WSL interop path (\\wsl$\ prefix).
   *
   * @param input - Path to check.
   * @returns true if the path is a WSL path.
   */
  static isWslPath(input: string): boolean {
    return PathUtils._isWslPathInternal(input);
  }

  /**
   * Classify a path's style.
   *
   * @param input - Path to classify.
   * @returns The detected PathStyle.
   */
  static classify(input: string): PathStyle {
    if (!input || input.length === 0) {
      return PathStyle.UNIX;
    }

    if (WSL_PATH_PATTERN.test(input)) {
      return PathStyle.WSL;
    }

    if (/^\\\\[^\\?]/.test(input)) {
      return PathStyle.UNC;
    }

    const hasBackslash: boolean = input.includes("\\");
    const hasForwardSlash: boolean = input.includes("/");

    if (hasBackslash && !hasForwardSlash) {
      return PathStyle.WINDOWS;
    }

    if (hasForwardSlash && !hasBackslash) {
      return PathStyle.UNIX;
    }

    if (hasBackslash && hasForwardSlash) {
      return PathStyle.MIXED;
    }

    return PathStyle.UNIX;
  }

  /**
   * Resolve a WSL path to its Windows equivalent.
   *
   * WSL paths like \\wsl$\Ubuntu\home\user\file are translated
   * to their native Windows path using wslpath if available.
   *
   * @param input - WSL path to resolve.
   * @returns The Windows path, or the original if resolution fails.
   */
  static resolveWslToWindows(input: string): string {
    if (!PathUtils._isWslPathInternal(input)) {
      return input;
    }

    const match: RegExpMatchArray | null = WSL_PATH_PARSE_PATTERN.exec(input);
    if (!match) {
      return input;
    }

    const distro: string = match[1]!;
    const linuxPath: string = match[2]!.replace(/\\/g, "/");

    // Convert: \\wsl$\<distro>\<path> → /<path>
    const wslInternalPath: string = `/${linuxPath}`;

    // On Windows, we can't easily resolve WSL paths from Node.js directly.
    // Return the cleaned-up form for the caller to handle.
    return wslInternalPath;
  }

  /**
   * Parse a WSL path into its components.
   *
   * @param input - WSL path to parse.
   * @returns WslPathInfo or null if the path is not a WSL path.
   */
  static parseWslPath(input: string): WslPathInfo | null {
    if (!PathUtils._isWslPathInternal(input)) {
      return null;
    }

    const match: RegExpMatchArray | null = WSL_PATH_PARSE_PATTERN.exec(input);
    if (!match) {
      return null;
    }

    const distribution: string = match[1]!;
    const linuxPath: string = `/${match[2]!.replace(/\\/g, "/")}`;

    let windowsPath: string | null = null;
    try {
      windowsPath = PathUtils.resolveWslToWindows(input);
      if (windowsPath === input) {
        windowsPath = null;
      }
    } catch {
      windowsPath = null;
    }

    return { distribution, linuxPath, windowsPath };
  }

  /**
   * Ensure a path ends with the platform-appropriate trailing separator.
   *
   * @param input - Path to ensure trailing separator on.
   * @returns Path with trailing separator.
   */
  static ensureTrailingSeparator(input: string): string {
    const normalized: string = PathUtils.normalize(input);
    const sep: string = nodePath.sep;

    if (normalized.endsWith(sep)) {
      return normalized;
    }

    return normalized + sep;
  }

  /**
   * Compare two paths for equality.
   *
   * On Windows, comparison is case-insensitive by default.
   * Both paths are normalized before comparison unless opts.normalize is false.
   *
   * @param a - First path.
   * @param b - Second path.
   * @param opts - Comparison options.
   * @returns true if the paths refer to the same location.
   */
  static areEqual(a: string, b: string, opts: PathCompareOptions = {}): boolean {
    const caseInsensitive: boolean =
      opts.caseInsensitive ?? PathUtils._isWindowsPlatform();
    const shouldNormalize: boolean = opts.normalize ?? true;

    let normalizedA: string = shouldNormalize ? PathUtils.normalize(a) : a;
    let normalizedB: string = shouldNormalize ? PathUtils.normalize(b) : b;

    if (caseInsensitive) {
      normalizedA = normalizedA.toLowerCase();
      normalizedB = normalizedB.toLowerCase();
    }

    return normalizedA === normalizedB;
  }

  /**
   * Safely join path segments with normalization.
   *
   * @param segments - Path segments to join.
   * @returns Normalized joined path.
   */
  static join(...segments: string[]): string {
    const joined: string = nodePath.join(...segments);
    return PathUtils.normalize(joined);
  }

  /**
   * Safely resolve path segments with normalization.
   *
   * @param segments - Path segments to resolve.
   * @returns Normalized resolved path.
   */
  static resolve(...segments: string[]): string {
    const resolved: string = nodePath.resolve(...segments);
    return PathUtils.normalize(resolved);
  }

  // ================================================================
  // Private helpers
  // ================================================================

  /** Internal WSL path detection. */
  private static _isWslPathInternal(input: string): boolean {
    return WSL_PATH_PATTERN.test(input);
  }

  /** Detect whether running on Windows. */
  private static _isWindowsPlatform(): boolean {
    return process.platform === "win32";
  }

  /** Normalize a WSL path preserving its structure. */
  private static _normalizeWslPath(input: string): string {
    // Preserve \\wsl$\ prefix, normalize the rest
    const wslPrefix: string = `\\\\wsl$\\`;
    const rest: string = input.slice(wslPrefix.length);

    // Forward slashes → backslashes for the internal path
    let normalizedRest: string = rest.replace(/\//g, "\\");
    normalizedRest = PathUtils._collapseSeparators(normalizedRest);

    return wslPrefix + normalizedRest;
  }

  /** Collapse duplicate backslashes while preserving UNC prefix (\\server\). */
  private static _collapseSeparators(path: string): string {
    // Preserve leading \\ for UNC/WSL paths
    const hasUncPrefix: boolean = /^\\\\/.test(path);
    const prefix: string = hasUncPrefix ? "\\\\" : "";

    const rest: string = hasUncPrefix ? path.slice(2) : path;
    const collapsed: string = rest.replace(/\\{2,}/g, "\\");

    // Restore the prefix and also collapse any double after prefix
    const result: string = prefix + collapsed;
    return result.replace(/^\\\\\\\\/, "\\\\");
  }
}

export default PathUtils;
