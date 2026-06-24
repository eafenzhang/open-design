/**
 * Open Design — Platform Mock
 *
 * Provides a mock implementation of the @open-design/platform module
 * for testing and when the actual platform module is not available.
 *
 * In production, this is replaced by the real @open-design/platform package
 * which provides runtime platform detection for the Electron app.
 */

/** Platform information and detection utilities. */
export const platform = {
  /** Whether the current platform is Windows. */
  isWindows: process.platform === "win32",

  /** Whether the current platform is macOS. */
  isMacOS: process.platform === "darwin",

  /** Whether the current platform is Linux. */
  isLinux: process.platform === "linux",

  /** The current platform name (returns Node's process.platform). */
  name: process.platform,

  /** The current architecture (e.g., 'x64', 'arm64'). */
  arch: process.arch,

  /**
   * Execute platform-specific code.
   * @param handlers - Object mapping platform names to handler functions.
   * @returns The result of the matching handler, or defaultValue if no match.
   */
  select<T>(handlers: Record<string, () => T>, defaultValue?: T): T | undefined {
    const handler = handlers[process.platform];
    if (handler) {
      return handler();
    }
    return defaultValue;
  },
};

export default platform;
