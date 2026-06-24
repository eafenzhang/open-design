#!/usr/bin/env node
/**
 * Open Design — Path Usage Audit Script
 *
 * Scans the entire project for raw `path.join`, `path.posix.join`,
 * `path.win32.join`, `path.resolve`, etc. calls that may need to be
 * wrapped with PathUtils.normalize().
 *
 * Usage:
 *   npx tsx scripts/audit-paths.ts [directory]
 *   npx tsx scripts/audit-paths.ts apps/packaged/src
 *
 * @module scripts/audit-paths
 */

import * as fs from "node:fs";
import * as nodePath from "node:path";

/** Log prefix for this script. */
const LOG_PREFIX = "[OpenDesign:AuditPaths]";

/** Patterns to search for in source code. */
const SEARCH_PATTERNS: readonly RegExp[] = [
  // path.join(...)
  /path\.join\s*\(/g,
  // path.posix.join(...)
  /path\.posix\.join\s*\(/g,
  // path.win32.join(...)
  /path\.win32\.join\s*\(/g,
  // path.resolve(...)
  /path\.resolve\s*\(/g,
  // path.posix.resolve(...)
  /path\.posix\.resolve\s*\(/g,
  // path.win32.resolve(...)
  /path\.win32\.resolve\s*\(/g,
  // String concatenation with path separators (potential bug)
  /['"]?\s*\+\s*['"][\\\/]['"]?\s*\+/,
  // Template literal with hardcoded separator
  /`[^`]*[\\\/][^`]*\$\{[^}]+\}[^`]*[\\\/]?[^`]*`/,
];

/** File extensions to scan. */
const SCAN_EXTENSIONS: ReadonlySet<string> = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

/** Directories to exclude from scanning. */
const EXCLUDE_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "out",
  ".git",
  ".next",
  "coverage",
  "__pycache__",
]);

/** Match result from a single file. */
interface MatchResult {
  file: string;
  line: number;
  column: number;
  pattern: string;
  content: string;
}

/**
 * Recursively collect all source files from a directory.
 */
function collectSourceFiles(dir: string): string[] {
  const results: string[] = [];
  const dirents: fs.Dirent[] = [];

  try {
    const entries: fs.Dirent[] = fs.readdirSync(dir, {
      withFileTypes: true,
    });
    dirents.push(...entries);
  } catch (err) {
    console.error(`${LOG_PREFIX} Cannot read directory: ${dir}`, err);
    return results;
  }

  for (const entry of dirents) {
    const fullPath: string = nodePath.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!EXCLUDE_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
        results.push(...collectSourceFiles(fullPath));
      }
    } else if (entry.isFile()) {
      const ext: string = nodePath.extname(entry.name).toLowerCase();
      if (SCAN_EXTENSIONS.has(ext)) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

/**
 * Scan a single file for path-related patterns.
 */
function scanFile(filePath: string): MatchResult[] {
  const results: MatchResult[] = [];

  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    console.error(`${LOG_PREFIX} Cannot read file: ${filePath}`);
    return results;
  }

  const lines: string[] = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line: string = lines[i] ?? "";
    const lineNumber: number = i + 1;

    // Skip comment-only lines
    const trimmedLine: string = line.trim();
    if (
      trimmedLine.startsWith("//") ||
      trimmedLine.startsWith("/*") ||
      trimmedLine.startsWith("*") ||
      trimmedLine.startsWith("#")
    ) {
      continue;
    }

    for (const pattern of SEARCH_PATTERNS) {
      // Reset lastIndex for global regexes
      pattern.lastIndex = 0;

      let match: RegExpExecArray | null;
      while ((match = pattern.exec(line)) !== null) {
        results.push({
          file: filePath,
          line: lineNumber,
          column: match.index + 1,
          pattern: pattern.source,
          content: line.trim(),
        });
      }
    }
  }

  return results;
}

/**
 * Main audit function.
 */
function auditPaths(rootDir: string): void {
  console.log(`${LOG_PREFIX} Scanning directory: ${rootDir}`);
  console.log(`${LOG_PREFIX} Patterns: ${SEARCH_PATTERNS.length} rules`);
  console.log("-".repeat(80));

  const files: string[] = collectSourceFiles(rootDir);
  console.log(
    `${LOG_PREFIX} Found ${files.length} source files to scan.`,
  );

  const allMatches: MatchResult[] = [];

  for (const file of files) {
    const matches: MatchResult[] = scanFile(file);
    allMatches.push(...matches);
  }

  // Group matches by file
  const grouped: Map<string, MatchResult[]> = new Map();
  for (const match of allMatches) {
    const existing: MatchResult[] | undefined = grouped.get(match.file);
    if (existing) {
      existing.push(match);
    } else {
      grouped.set(match.file, [match]);
    }
  }

  // Print report
  console.log("");
  console.log("=".repeat(80));
  console.log("  PATH AUDIT REPORT");
  console.log("=".repeat(80));
  console.log(`  Total matches: ${allMatches.length}`);
  console.log(`  Files affected: ${grouped.size}`);
  console.log("=".repeat(80));
  console.log("");

  if (allMatches.length === 0) {
    console.log("  ✅ No path issues detected. All clear!");
    return;
  }

  let count = 0;
  for (const [file, matches] of grouped.entries()) {
    console.log(`  📄 ${file}`);
    for (const match of matches) {
      count++;
      console.log(
        `     L${String(match.line).padStart(4)}:${String(match.column).padStart(3)} | ${match.content}`,
      );
    }
    console.log("");
  }

  console.log("-".repeat(80));
  console.log(
    `  SUMMARY: ${allMatches.length} potential path issues in ${grouped.size} files.`,
  );
  console.log(
    "  Consider wrapping with PathUtils.normalize() for cross-platform safety.",
  );
  console.log("-".repeat(80));

  // Exit with non-zero code to fail CI if issues found
  if (allMatches.length > 0) {
    console.log(
      `${LOG_PREFIX} WARNING: Path audit found issues. Review the report above.`,
    );
    // Soft fail — warn but don't block
  }
}

// ================================================================
// Entry point
// ================================================================
const targetDir: string = process.argv[2] ?? process.cwd();

if (!fs.existsSync(targetDir)) {
  console.error(`${LOG_PREFIX} Directory not found: ${targetDir}`);
  process.exit(1);
}

if (!fs.statSync(targetDir).isDirectory()) {
  console.error(`${LOG_PREFIX} Not a directory: ${targetDir}`);
  process.exit(1);
}

auditPaths(targetDir);
