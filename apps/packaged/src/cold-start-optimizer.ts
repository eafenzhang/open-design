/**
 * Open Design — Cold Start Optimizer
 *
 * Optimizes Windows cold start performance through:
 * 1. NSIS installer size reduction (remove unused Electron components)
 * 2. Windows Defender exclusion registration
 * 3. SQLite database pre-warming (WAL mode + pre-queries)
 * 4. Deferred loading configuration for non-critical modules
 *
 * @module cold-start-optimizer
 */

import { DefenderUtils } from "./defender-utils.js";
import { PathUtils } from "./path-utils.js";
import type { Result } from "./types/path-types.js";

/** Log prefix for this module. */
const LOG_PREFIX = "[OpenDesign:ColdStartOptimizer]";

/** NSIS configuration that the optimizer can modify. */
export interface NsisConfig {
  /** Whether to use LZMA compression (solid). */
  useLzma: boolean;

  /** Whether to enable ASAR packaging. */
  useAsar: boolean;

  /** Unused Electron components to exclude from the installer. */
  excludeComponents: string[];

  /** Whether to strip debug symbols. */
  stripDebugSymbols: boolean;
}

/** Default NSIS configuration. */
const DEFAULT_NSIS_CONFIG: NsisConfig = {
  useLzma: true,
  useAsar: true,
  excludeComponents: [
    "crashReporter",
    "electronDist/chrome_100_percent.pak",
    "electronDist/chrome_200_percent.pak",
    "electronDist/resources.pak",
    "electronDist/v8_context_snapshot.bin",
  ],
  stripDebugSymbols: true,
};

/** Deferred loading configuration for non-critical modules. */
export interface LazyLoadConfig {
  /** Delay before loading telemetry module (ms after ROUTE_STABLE). */
  telemetryDelay: number;

  /** Delay before initializing plugin system (ms after ROUTE_STABLE). */
  pluginSystemDelay: number;

  /** Whether to defer landing page component until after first route. */
  landingPageDefer: boolean;
}

/** Default lazy loading configuration. */
const DEFAULT_LAZY_LOAD_CONFIG: LazyLoadConfig = {
  telemetryDelay: 5_000,
  pluginSystemDelay: 10_000,
  landingPageDefer: true,
};

/**
 * Cold start optimizer for Windows.
 *
 * Delegates Defender operations to DefenderUtils, SQLite warmup
 * to a direct better-sqlite3 connection, and configures NSIS
 * and deferred loading options.
 */
export class ColdStartOptimizer {
  /** Current NSIS configuration. */
  private _nsisConfig: NsisConfig;

  /** Current lazy load configuration. */
  private _lazyLoadConfig: LazyLoadConfig;

  /** Path to the application directory (for Defender exclusion). */
  private readonly _appPath: string;

  /**
   * @param appPath - The application installation directory.
   * @param nsisConfig - Optional NSIS configuration overrides.
   * @param lazyLoadConfig - Optional lazy loading configuration.
   */
  constructor(
    appPath: string = "",
    nsisConfig: Partial<NsisConfig> = {},
    lazyLoadConfig: Partial<LazyLoadConfig> = {},
  ) {
    this._appPath = PathUtils.normalize(appPath);
    this._nsisConfig = { ...DEFAULT_NSIS_CONFIG, ...nsisConfig };
    this._lazyLoadConfig = {
      ...DEFAULT_LAZY_LOAD_CONFIG,
      ...lazyLoadConfig,
    };
  }

  /**
   * Optimize the NSIS installer configuration.
   *
   * Removes unused Electron components, enables LZMA compression,
   * and configures ASAR packaging to reduce installer size.
   *
   * @param config - NSIS configuration to optimize (mutates and returns).
   * @returns The optimized NSIS configuration.
   */
  optimizeNSIS(config: NsisConfig): NsisConfig {
    console.info(`${LOG_PREFIX} Optimizing NSIS configuration...`);

    // Apply LZMA compression
    config.useLzma = config.useLzma ?? this._nsisConfig.useLzma;

    // Enable ASAR packaging
    config.useAsar = config.useAsar ?? this._nsisConfig.useAsar;

    // Merge excluded components (deduplicate)
    if (this._nsisConfig.excludeComponents.length > 0) {
      config.excludeComponents = [
        ...new Set([
          ...(config.excludeComponents ?? []),
          ...this._nsisConfig.excludeComponents,
        ]),
      ];
    }

    // Strip debug symbols
    config.stripDebugSymbols =
      config.stripDebugSymbols ?? this._nsisConfig.stripDebugSymbols;

    console.info(
      `${LOG_PREFIX} NSIS optimized: lzma=${config.useLzma}, ` +
        `asar=${config.useAsar}, excludedComponents=${config.excludeComponents.length}, ` +
        `stripDebug=${config.stripDebugSymbols}`,
    );

    return config;
  }

  /**
   * Add the application directory to Windows Defender exclusion list.
   *
   * This is a non-critical operation; failures are logged but do not
   * block application startup.
   *
   * @param appPath - Path to add (defaults to constructor appPath).
   */
  async addDefenderExclusion(appPath?: string): Promise<void> {
    const targetPath: string = PathUtils.normalize(
      appPath ?? this._appPath,
    );

    if (!targetPath || targetPath.length === 0) {
      console.warn(
        `${LOG_PREFIX} No app path configured for Defender exclusion.`,
      );
      return;
    }

    console.info(
      `${LOG_PREFIX} Requesting Defender exclusion for: ${targetPath}`,
    );

    const result: Result<boolean> =
      await DefenderUtils.addExclusion(targetPath);

    if (!result.success) {
      console.warn(
        `${LOG_PREFIX} Defender exclusion failed (non-critical): ${result.error.message}`,
      );
    }
  }

  /**
   * Pre-warm SQLite database for faster cold starts.
   *
   * Executes PRAGMA journal_mode=WAL, PRAGMA synchronous=NORMAL,
   * and pre-runs common queries to warm the page cache.
   *
   * @param dbPath - Path to the SQLite database file.
   */
  async warmupSQLite(dbPath: string): Promise<void> {
    const normalizedPath: string = PathUtils.normalize(dbPath);

    console.info(`${LOG_PREFIX} Warming up SQLite: ${normalizedPath}`);

    try {
      // Dynamic import to avoid hard dependency on better-sqlite3 at module level
      const Database = (await import("better-sqlite3")).default;

      const db = new Database(normalizedPath, {
        readonly: false,
        fileMustExist: true,
        timeout: 5_000,
      });

      try {
        // Spread PRAGMA operations across 6 ticks using setImmediate
        // to avoid blocking the event loop during SQLite initialization
        await new Promise<void>((resolve) => setImmediate(resolve));

        // Tick 1: Enable WAL mode for better concurrent read performance
        db.pragma("journal_mode = WAL");

        await new Promise<void>((resolve) => setImmediate(resolve));

        // Tick 2: Reduce synchronous level for better write performance
        db.pragma("synchronous = NORMAL");

        await new Promise<void>((resolve) => setImmediate(resolve));

        // Tick 3: Set cache size to ~64MB for faster reads
        db.pragma("cache_size = -64000");

        await new Promise<void>((resolve) => setImmediate(resolve));

        // Tick 4: Enable memory-mapped I/O for faster reads (256MB)
        db.pragma("mmap_size = 268435456");

        await new Promise<void>((resolve) => setImmediate(resolve));

        // Tick 5: Pre-execute common queries to populate the cache
        try {
          db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table'",
          ).all();
        } catch {
          // Schema may vary — ignore
        }

        await new Promise<void>((resolve) => setImmediate(resolve));

        // Tick 6: Run a warmup scan to populate page cache
        try {
          const tables = db
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .all() as Array<{ name: string }>;

          for (const table of tables) {
            try {
              db.prepare(`SELECT COUNT(*) FROM "${table.name}"`).get();
            } catch {
              // Table may be virtual or inaccessible — ignore
            }
          }
        } catch {
          // Pre-query warmup failed — non-critical
        }

        console.info(
          `${LOG_PREFIX} SQLite warmup complete: ${normalizedPath}`,
        );
      } finally {
        db.close();
      }
    } catch (err) {
      const message: string =
        err instanceof Error ? err.message : String(err);

      console.warn(
        `${LOG_PREFIX} SQLite warmup failed (non-critical): ${message}`,
      );

      throw err; // Re-throw to let caller decide on handling
    }
  }

  /**
   * Configure deferred loading for non-critical modules.
   *
   * Returns a LazyLoadConfig that specifies when to load:
   * - Telemetry module
   * - Plugin system
   * - Landing page components
   *
   * @returns The lazy loading configuration.
   */
  configureLazyLoading(): LazyLoadConfig {
    console.info(
      `${LOG_PREFIX} Configuring deferred loading: ` +
        `telemetry=${this._lazyLoadConfig.telemetryDelay}ms, ` +
        `plugins=${this._lazyLoadConfig.pluginSystemDelay}ms, ` +
        `landingDefer=${this._lazyLoadConfig.landingPageDefer}`,
    );

    return { ...this._lazyLoadConfig };
  }

  /**
   * Get the current NSIS configuration.
   */
  getNsisConfig(): Readonly<NsisConfig> {
    return this._nsisConfig;
  }

  /**
   * Get the current lazy loading configuration.
   */
  getLazyLoadConfig(): Readonly<LazyLoadConfig> {
    return this._lazyLoadConfig;
  }
}

export default ColdStartOptimizer;
