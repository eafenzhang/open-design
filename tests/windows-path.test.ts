/**
 * Unit tests for PathUtils — Windows path normalization, WSL paths,
 * UNC paths, drive letters, and case-insensitive comparison.
 *
 * @module tests/unit/windows-path
 */

import { describe, it, expect } from "vitest";
import { PathUtils } from "../../apps/packaged/src/path-utils.js";
import { PathStyle } from "../../apps/packaged/src/types/path-types.js";

/** Build a Windows path string with backslashes from segments. */
function wp(...segments: string[]): string {
  return segments.join("\\");
}

/** Build a UNC path string. */
function unc(server: string, share: string, ...rest: string[]): string {
  return "\\\\" + [server, share, ...rest].join("\\");
}

/** Build a WSL path string. */
function wsl(distro: string, ...rest: string[]): string {
  return "\\\\wsl$\\" + [distro, ...rest].join("\\");
}

describe("PathUtils", () => {
  // ================================================================
  // normalize()
  // ================================================================
  describe("normalize()", () => {
    it("should preserve already-normalized Windows paths", () => {
      const input = wp("C:", "Users", "test", "file.txt");
      const result = PathUtils.normalize(input);
      expect(result).toBe(input);
    });

    it("should convert forward slashes to backslashes on Windows", () => {
      const input = "C:/Users/test/file.txt";
      const result = PathUtils.normalize(input);
      if (process.platform === "win32") {
        expect(result).toBe(wp("C:", "Users", "test", "file.txt"));
      } else {
        expect(result).toBe("C:/Users/test/file.txt");
      }
    });

    it("should collapse duplicate separators", () => {
      const input = "C:\\\\Users\\\\\\\\test\\\\\\file.txt";
      const result = PathUtils.normalize(input);
      expect(result).toBe(wp("C:", "Users", "test", "file.txt"));
    });

    it("should resolve . and .. segments", () => {
      const input = wp("C:", "Users", "test", "..", "admin", ".", "file.txt");
      const result = PathUtils.normalize(input);
      expect(result).toBe(wp("C:", "Users", "admin", "file.txt"));
    });

    it("should handle empty input", () => {
      expect(PathUtils.normalize("")).toBe("");
    });

    it("should handle mixed forward/backward slashes", () => {
      const input = "C:\\Users/test\\mixed/path";
      const result = PathUtils.normalize(input);
      if (process.platform === "win32") {
        expect(result).toBe(wp("C:", "Users", "test", "mixed", "path"));
      } else {
        expect(result).toBe("C:/Users/test/mixed/path");
      }
    });
  });

  // ================================================================
  // WSL paths
  // ================================================================
  describe("WSL paths", () => {
    it("should detect WSL paths via isWslPath()", () => {
      const wslPath = wsl("Ubuntu", "home", "user", "file.txt");
      expect(PathUtils.isWslPath(wslPath)).toBe(true);
    });

    it("should detect WSL paths case-insensitively", () => {
      const wslPath = "\\\\WSL$\\Ubuntu\\home\\user\\file.txt";
      expect(PathUtils.isWslPath(wslPath)).toBe(true);
    });

    it("should not flag non-WSL paths as WSL", () => {
      expect(PathUtils.isWslPath(wp("C:", "Users", "test"))).toBe(false);
      expect(PathUtils.isWslPath("/home/user")).toBe(false);
      expect(PathUtils.isWslPath(unc("server", "share"))).toBe(false);
    });

    it("should normalize WSL paths preserving the prefix", () => {
      const wslPath = "\\\\wsl$\\Ubuntu\\home//user\\.\\\\file.txt";
      const result = PathUtils.normalize(wslPath);
      expect(result).toMatch(/^\\\\wsl\$\\Ubuntu\\/);
    });

    it("should parse WSL paths into components", () => {
      const wslPath = wsl("Ubuntu", "home", "user", "file.txt");
      const parsed = PathUtils.parseWslPath(wslPath);
      expect(parsed).not.toBeNull();
      expect(parsed!.distribution).toBe("Ubuntu");
      expect(parsed!.linuxPath).toBe("/home/user/file.txt");
    });

    it("should return null from parseWslPath for non-WSL paths", () => {
      expect(PathUtils.parseWslPath(wp("C:", "foo"))).toBeNull();
    });

    it("should resolveWslToWindows to internal path", () => {
      const wslPath = wsl("Debian", "var", "www");
      const result = PathUtils.resolveWslToWindows(wslPath);
      expect(result).toBe("/var/www");
    });

    it("should return original for non-WSL input in resolveWslToWindows", () => {
      const path = wp("C:", "Windows", "System32");
      expect(PathUtils.resolveWslToWindows(path)).toBe(path);
    });
  });

  // ================================================================
  // UNC paths
  // ================================================================
  describe("UNC paths", () => {
    it("should classify UNC paths correctly", () => {
      const uncPath = unc("server", "share", "file.txt");
      expect(PathUtils.classify(uncPath)).toBe(PathStyle.UNC);
    });

    it("should normalize UNC paths without mangling the server prefix", () => {
      const uncPath = "\\\\server\\share\\\\dir\\\\file.txt";
      const result = PathUtils.normalize(uncPath);
      expect(result.startsWith(unc("server", "share"))).toBe(true);
      expect(result).toBe(unc("server", "share", "dir", "file.txt"));
    });
  });

  // ================================================================
  // Drive letters
  // ================================================================
  describe("Drive letters", () => {
    it("should normalize lower-case drive letters to upper-case", () => {
      const input = "c:\\Users\\test";
      const result = PathUtils.normalize(input);
      if (process.platform === "win32") {
        expect(result).toBe(wp("C:", "Users", "test"));
      }
    });

    it("should handle multiple drive letters in a path", () => {
      const input = "C:\\Users\\D:\\test";
      const result = PathUtils.normalize(input);
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });

    it("should recognize drive-letter-style paths on Unix", () => {
      const input = "C:/Users/test";
      const style = PathUtils.classify(input);
      // C:/ has no backslashes, so it's classified as UNIX style on all platforms
      expect(style).toBe(PathStyle.UNIX);
    });
  });

  // ================================================================
  // Case-insensitive comparison
  // ================================================================
  describe("areEqual()", () => {
    it("should compare paths case-insensitively on Windows", () => {
      const a = wp("C:", "Users", "Test", "File.txt");
      const b = "c:\\users\\test\\file.txt";

      if (process.platform === "win32") {
        expect(PathUtils.areEqual(a, b)).toBe(true);
      }
    });

    it("should respect explicit caseInsensitive option", () => {
      const a = wp("C:", "Users", "Test");
      const b = "c:\\users\\test";

      expect(PathUtils.areEqual(a, b, { caseInsensitive: true })).toBe(true);
      expect(PathUtils.areEqual(a, b, { caseInsensitive: false })).toBe(false);
    });

    it("should normalize before comparing by default", () => {
      const a = "C:\\Users\\\\test\\dir";
      const b = "C:/Users/test/dir";

      if (process.platform === "win32") {
        expect(PathUtils.areEqual(a, b)).toBe(true);
      }
    });

    it("should skip normalization when normalize: false", () => {
      const a = "C:\\Users\\\\test";
      const b = wp("C:", "Users", "test");

      expect(PathUtils.areEqual(a, b, { normalize: false })).toBe(false);
    });

    it("should handle identical paths", () => {
      const path = wp("C:", "Users", "test");
      expect(PathUtils.areEqual(path, path)).toBe(true);
    });
  });

  // ================================================================
  // toWindowsStyle / toUnixStyle
  // ================================================================
  describe("toWindowsStyle()", () => {
    it("should convert forward slashes to backslashes", () => {
      const result = PathUtils.toWindowsStyle("C:/Users/test/file.txt");
      expect(result).not.toContain("/");
      expect(result).toContain("\\");
    });
  });

  describe("toUnixStyle()", () => {
    it("should convert backslashes to forward slashes", () => {
      const result = PathUtils.toUnixStyle(wp("C:", "Users", "test", "file.txt"));
      expect(result).not.toContain("\\");
      expect(result).toContain("/");
    });
  });

  // ================================================================
  // classify()
  // ================================================================
  describe("classify()", () => {
    it("should classify WSL paths", () => {
      expect(PathUtils.classify(wsl("Ubuntu", "home"))).toBe(PathStyle.WSL);
    });

    it("should classify UNC paths", () => {
      expect(PathUtils.classify(unc("server", "share"))).toBe(PathStyle.UNC);
    });

    it("should classify Windows paths", () => {
      expect(PathUtils.classify(wp("C:", "Windows", "System32"))).toBe(
        PathStyle.WINDOWS,
      );
    });

    it("should classify Unix paths", () => {
      expect(PathUtils.classify("/home/user/docs")).toBe(PathStyle.UNIX);
    });

    it("should classify mixed paths", () => {
      expect(PathUtils.classify("C:\\Users\\test/file.txt")).toBe(
        PathStyle.MIXED,
      );
    });

    it("should classify empty paths as UNIX", () => {
      expect(PathUtils.classify("")).toBe(PathStyle.UNIX);
    });
  });

  // ================================================================
  // ensureTrailingSeparator()
  // ================================================================
  describe("ensureTrailingSeparator()", () => {
    it("should add a trailing separator when missing", () => {
      const result = PathUtils.ensureTrailingSeparator(wp("C:", "Users", "test"));
      expect(result.endsWith("\\") || result.endsWith("/")).toBe(true);
    });

    it("should not duplicate an existing trailing separator", () => {
      if (process.platform === "win32") {
        const result = PathUtils.ensureTrailingSeparator("C:\\Users\\test\\");
        expect(result.endsWith("\\\\")).toBe(false);
      }
    });
  });

  // ================================================================
  // join() / resolve()
  // ================================================================
  describe("join()", () => {
    it("should join and normalize path segments", () => {
      const result = PathUtils.join("C:\\Users", "test", "file.txt");
      expect(result).toBe(wp("C:", "Users", "test", "file.txt"));
    });
  });

  describe("resolve()", () => {
    it("should resolve and normalize relative paths", () => {
      const result = PathUtils.resolve("C:\\Users", "..", "test");
      expect(result).toContain("test");
      expect(result).not.toContain("..");
    });
  });

  // ================================================================
  // normalizeWithResult()
  // ================================================================
  describe("normalizeWithResult()", () => {
    it("should return original style and modification flag", () => {
      const result = PathUtils.normalizeWithResult("C:\\Users\\\\test");
      expect(result.originalStyle).toBe(PathStyle.WINDOWS);
      expect(result.wasModified).toBe(true);
      expect(result.normalized).toBe(wp("C:", "Users", "test"));
    });

    it("should report wasModified=false for already-normalized paths", () => {
      const result = PathUtils.normalizeWithResult(wp("C:", "Users", "test"));
      if (process.platform === "win32") {
        expect(result.wasModified).toBe(false);
      }
    });
  });
});
