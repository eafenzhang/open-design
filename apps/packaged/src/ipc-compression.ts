/**
 * Open Design — IPC Payload Compression
 *
 * Transparent gzip compression for large IPC payloads (> 64KB).
 * Uses a decorator pattern to wrap existing ipcMain.handle handlers
 * so that compression/decompression is invisible to callers.
 *
 * Compression is transparent to the renderer: the preload script
 * automatically decompresses responses with the gzip magic number
 * (0x1f8b), so existing ipcRenderer.invoke callers need no changes.
 *
 * @module ipc-compression
 */

import { gzipSync, gunzipSync } from "node:zlib";
import { PERF_CONSTANTS } from "./types/performance-metrics.js";

/** Log prefix for this module. */
const LOG_PREFIX = "[OpenDesign:IpcCompression]";

/** gzip magic number bytes (first byte 0x1f, second 0x8b). */
const GZIP_MAGIC_BYTE_0: number = 0x1f;
const GZIP_MAGIC_BYTE_1: number = 0x8b;

/**
 * Options for configuring IPC compression behavior.
 */
export interface IpcCompressionOptions {
  /** Payload size threshold in bytes (default: 64KB). */
  thresholdBytes: number;

  /** gzip compression level (0-9, default: 6). */
  compressionLevel: number;

  /** Whether compression is enabled (default: true). */
  enabled: boolean;
}

/** Default compression options. */
const DEFAULT_OPTIONS: IpcCompressionOptions = {
  thresholdBytes: PERF_CONSTANTS.IPC_COMPRESSION_THRESHOLD_BYTES,
  compressionLevel: 6,
  enabled: true,
};

/**
 * Transparent IPC payload compression using gzip.
 *
 * Automatically compresses payloads larger than the configured threshold
 * and decompresses them on the receiving end. Uses a decorator pattern
 * via wrapHandler() to interpose compression on existing ipcMain.handle
 * registrations without modifying handler logic.
 */
export class IpcCompression {
  private readonly _options: IpcCompressionOptions;
  private _totalCompressed: number;
  private _totalDecompressed: number;
  private _bytesSaved: number;

  /**
   * @param options - Compression configuration options.
   */
  constructor(options: Partial<IpcCompressionOptions> = {}) {
    this._options = { ...DEFAULT_OPTIONS, ...options };
    this._totalCompressed = 0;
    this._totalDecompressed = 0;
    this._bytesSaved = 0;

    console.info(
      `${LOG_PREFIX} IPC compression initialized ` +
        `(threshold: ${this._options.thresholdBytes} bytes, ` +
        `level: ${this._options.compressionLevel}, ` +
        `enabled: ${this._options.enabled})`,
    );
  }

  /**
   * Compress a payload if it exceeds the size threshold.
   *
   * Returns the compressed Buffer with gzip magic number prefix,
   * or the original payload if compression is disabled or the
   * payload is below the threshold.
   *
   * @param data - The payload to potentially compress.
   * @returns Compressed Buffer or original Buffer.
   */
  compressPayload(data: Buffer): Buffer {
    if (!this._options.enabled) {
      return data;
    }

    if (data.length <= this._options.thresholdBytes) {
      return data;
    }

    try {
      const compressed: Buffer = gzipSync(data, {
        level: this._options.compressionLevel,
      });

      const saved: number = data.length - compressed.length;
      this._totalCompressed++;
      this._bytesSaved += saved;

      console.debug(
        `${LOG_PREFIX} Compressed: ${data.length} → ${compressed.length} bytes ` +
          `(${((saved / data.length) * 100).toFixed(1)}% reduction)`,
      );

      return compressed;
    } catch (err) {
      console.warn(
        `${LOG_PREFIX} Compression failed, sending uncompressed:`,
        err instanceof Error ? err.message : err,
      );
      return data;
    }
  }

  /**
   * Decompress a payload if it has the gzip magic number prefix.
   *
   * Detects gzip-compressed data by checking the first two bytes
   * for the gzip magic number (0x1f 0x8b). If detected, decompresses;
   * otherwise returns the payload unchanged.
   *
   * @param data - The payload to potentially decompress.
   * @returns Decompressed Buffer or original Buffer.
   */
  decompressPayload(data: Buffer): Buffer {
    if (data.length < 2) {
      return data;
    }

    // Check for gzip magic number
    if (data[0] !== GZIP_MAGIC_BYTE_0 || data[1] !== GZIP_MAGIC_BYTE_1) {
      return data;
    }

    try {
      const decompressed: Buffer = gunzipSync(data);

      this._totalDecompressed++;

      console.debug(
        `${LOG_PREFIX} Decompressed: ${data.length} → ${decompressed.length} bytes`,
      );

      return decompressed;
    } catch (err) {
      console.warn(
        `${LOG_PREFIX} Decompression failed, returning raw:`,
        err instanceof Error ? err.message : err,
      );
      return data;
    }
  }

  /**
   * Wrap an existing ipcMain.handle handler with transparent compression.
   *
   * The returned wrapper:
   * 1. Calls the original handler to get the result
   * 2. If the result is a Buffer (or can be converted), compresses it
   * 3. Returns the (potentially compressed) result
   *
   * Usage:
   * ```
   * const originalHandler = async (_event, arg) => { ... return data; };
   * ipcMain.handle("my-channel", ipcCompression.wrapHandler(originalHandler));
   * ```
   *
   * @param handler - The original IPC handler function.
   * @returns A wrapped handler with transparent compression.
   */
  wrapHandler(
    handler: (
      event: Electron.IpcMainInvokeEvent,
      ...args: unknown[]
    ) => Promise<unknown> | unknown,
  ): (
    event: Electron.IpcMainInvokeEvent,
    ...args: unknown[]
  ) => Promise<unknown> {
    return async (
      event: Electron.IpcMainInvokeEvent,
      ...args: unknown[]
    ): Promise<unknown> => {
      const result: unknown = await handler(event, ...args);

      // Only compress Buffer results
      if (result instanceof Buffer) {
        return this.compressPayload(result);
      }

      // If result is an object with a Buffer property, try to compress
      if (
        result !== null &&
        typeof result === "object" &&
        "data" in result &&
        (result as Record<string, unknown>).data instanceof Buffer
      ) {
        const obj = result as Record<string, unknown>;
        obj.data = this.compressPayload(obj.data as Buffer);
        return obj;
      }

      return result;
    };
  }

  /**
   * Wrap a handler with transparent decompression for incoming args.
   *
   * Checks if any argument is a compressed Buffer and decompresses it
   * before passing to the original handler.
   *
   * @param handler - The original IPC handler function.
   * @returns A wrapped handler with transparent decompression.
   */
  wrapHandlerWithDecompress(
    handler: (
      event: Electron.IpcMainInvokeEvent,
      ...args: unknown[]
    ) => Promise<unknown> | unknown,
  ): (
    event: Electron.IpcMainInvokeEvent,
    ...args: unknown[]
  ) => Promise<unknown> {
    return async (
      event: Electron.IpcMainInvokeEvent,
      ...args: unknown[]
    ): Promise<unknown> => {
      // Decompress any Buffer arguments
      const decompressedArgs: unknown[] = args.map((arg: unknown) => {
        if (arg instanceof Buffer) {
          return this.decompressPayload(arg);
        }
        return arg;
      });

      return handler(event, ...decompressedArgs);
    };
  }

  /**
   * Get compression statistics.
   */
  getStats(): Readonly<{
    totalCompressed: number;
    totalDecompressed: number;
    bytesSaved: number;
    enabled: boolean;
    thresholdBytes: number;
  }> {
    return {
      totalCompressed: this._totalCompressed,
      totalDecompressed: this._totalDecompressed,
      bytesSaved: this._bytesSaved,
      enabled: this._options.enabled,
      thresholdBytes: this._options.thresholdBytes,
    };
  }

  /**
   * Enable or disable compression at runtime.
   */
  setEnabled(enabled: boolean): void {
    this._options.enabled = enabled;
    console.info(
      `${LOG_PREFIX} IPC compression ${enabled ? "enabled" : "disabled"}.`,
    );
  }
}

export default IpcCompression;
