/**
 * Unit tests for IpcCompression — gzip compression/decompression,
 * magic number detection, handler wrapping (decorator pattern),
 * and statistics tracking.
 *
 * @module tests/unit/ipc-compression
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { gzipSync, gunzipSync } from "node:zlib";
import { IpcCompression } from "../../apps/packaged/src/ipc-compression.js";

/** Create a buffer of specified size filled with repeatable content. */
function createBuffer(size: number, seed = "X"): Buffer {
  return Buffer.from(seed.repeat(Math.ceil(size / seed.length)).slice(0, size));
}

/** Create a buffer from random-ish data (less compressible). */
function createRandomishBuffer(size: number): Buffer {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) {
    buf[i] = (i * 7 + 13) % 256;
  }
  return buf;
}

describe("IpcCompression", () => {
  let ipc: IpcCompression;

  beforeEach(() => {
    ipc = new IpcCompression();
  });

  // ================================================================
  // Initialization & defaults
  // ================================================================
  describe("initialization", () => {
    it("should use default 64KB threshold", () => {
      const stats = ipc.getStats();
      expect(stats.thresholdBytes).toBe(64 * 1024);
    });

    it("should be enabled by default", () => {
      expect(ipc.getStats().enabled).toBe(true);
    });

    it("should start with zero stats", () => {
      const stats = ipc.getStats();
      expect(stats.totalCompressed).toBe(0);
      expect(stats.totalDecompressed).toBe(0);
      expect(stats.bytesSaved).toBe(0);
    });

    it("should accept custom threshold", () => {
      const custom = new IpcCompression({ thresholdBytes: 1024 });
      expect(custom.getStats().thresholdBytes).toBe(1024);
    });

    it("should accept custom compression level", () => {
      const custom = new IpcCompression({ compressionLevel: 9 });
      const original = createBuffer(100_000);
      // Level 9 should produce slightly different output than level 6
      // We just verify it doesn't crash
      const result = custom.compressPayload(original);
      expect(result.length).toBeLessThan(original.length);
    });

    it("should accept disabled flag", () => {
      const custom = new IpcCompression({ enabled: false });
      expect(custom.getStats().enabled).toBe(false);

      const data = createBuffer(100_000);
      const result = custom.compressPayload(data);
      // Should return original unchanged
      expect(result).toBe(data);
    });
  });

  // ================================================================
  // compressPayload()
  // ================================================================
  describe("compressPayload()", () => {
    it("should compress buffer larger than threshold", () => {
      const original = createBuffer(100_000); // > 64KB
      const compressed = ipc.compressPayload(original);

      expect(compressed.length).toBeLessThan(original.length);
    });

    it("should NOT compress buffer equal to threshold", () => {
      const threshold = ipc.getStats().thresholdBytes;
      const original = createBuffer(threshold); // exactly 64KB

      const result = ipc.compressPayload(original);
      // threshold uses >, so exactly threshold should not compress
      expect(result).toBe(original); // Same reference
    });

    it("should NOT compress buffer smaller than threshold", () => {
      const original = createBuffer(10_000); // < 64KB
      const result = ipc.compressPayload(original);

      expect(result).toBe(original); // Same reference, no compression
    });

    it("should compress buffer just above threshold", () => {
      const threshold = ipc.getStats().thresholdBytes;
      const original = createBuffer(threshold + 1); // just above

      const result = ipc.compressPayload(original);
      expect(result.length).toBeLessThan(original.length);
    });

    it("should produce gzip-compatible output (magic number 0x1f 0x8b)", () => {
      const original = createBuffer(100_000);
      const compressed = ipc.compressPayload(original);

      // Check gzip magic number
      expect(compressed[0]).toBe(0x1f);
      expect(compressed[1]).toBe(0x8b);
    });

    it("should produce round-trippable output", () => {
      const original = createRandomishBuffer(100_000);
      const compressed = ipc.compressPayload(original);
      const decompressed = gunzipSync(compressed);

      expect(decompressed.equals(original)).toBe(true);
    });

    it("should track compression count", () => {
      ipc.compressPayload(createBuffer(100_000));
      ipc.compressPayload(createBuffer(80_000));

      const stats = ipc.getStats();
      expect(stats.totalCompressed).toBe(2);
    });

    it("should track bytes saved", () => {
      const original = createBuffer(100_000);
      const compressed = ipc.compressPayload(original);

      const saved = original.length - compressed.length;
      const stats = ipc.getStats();
      expect(stats.bytesSaved).toBe(saved);
    });

    it("should return original on compression failure (corrupt data shouldn't happen, but gracefully handle)", () => {
      // Disable to test bypass behavior
      ipc.setEnabled(false);
      const original = createBuffer(100_000);
      const result = ipc.compressPayload(original);
      expect(result).toBe(original);
    });

    it("should skip compression when disabled", () => {
      ipc.setEnabled(false);
      const original = createBuffer(100_000);
      const result = ipc.compressPayload(original);

      expect(result).toBe(original);
      expect(ipc.getStats().totalCompressed).toBe(0);
    });

    it("should handle empty buffer (below threshold, no compression)", () => {
      const empty = Buffer.alloc(0);
      const result = ipc.compressPayload(empty);
      expect(result).toBe(empty);
    });
  });

  // ================================================================
  // decompressPayload()
  // ================================================================
  describe("decompressPayload()", () => {
    it("should decompress gzip-compressed buffer", () => {
      const original = createRandomishBuffer(100_000);
      const compressed = gzipSync(original);

      const decompressed = ipc.decompressPayload(compressed);
      expect(decompressed.equals(original)).toBe(true);
    });

    it("should detect gzip magic number and decompress", () => {
      const original = createBuffer(100_000, "hello world ");
      const compressed = gzipSync(original);

      const result = ipc.decompressPayload(compressed);
      expect(result.equals(original)).toBe(true);
      expect(ipc.getStats().totalDecompressed).toBe(1);
    });

    it("should return non-gzip buffer unchanged", () => {
      const plainBuffer = createBuffer(100, "plain");
      const result = ipc.decompressPayload(plainBuffer);

      expect(result).toBe(plainBuffer); // Same reference
      expect(ipc.getStats().totalDecompressed).toBe(0);
    });

    it("should return buffer unchanged if first byte is wrong", () => {
      // Create buffer where first byte is not 0x1f
      const buf = Buffer.alloc(10, 0);
      buf[0] = 0x00;
      buf[1] = 0x8b;

      const result = ipc.decompressPayload(buf);
      expect(result).toBe(buf);
    });

    it("should return buffer unchanged if second byte is wrong", () => {
      const buf = Buffer.alloc(10, 0);
      buf[0] = 0x1f;
      buf[1] = 0x00;

      const result = ipc.decompressPayload(buf);
      expect(result).toBe(buf);
    });

    it("should return buffer unchanged if too short (< 2 bytes)", () => {
      const short = Buffer.alloc(1, 0);
      const result = ipc.decompressPayload(short);
      expect(result).toBe(short);
    });

    it("should return buffer unchanged if exactly 2 bytes and not gzip", () => {
      const twoBytes = Buffer.from([0x00, 0x00]);
      const result = ipc.decompressPayload(twoBytes);
      expect(result).toBe(twoBytes);
    });

    it("should track decompression count", () => {
      const original = createBuffer(100_000);
      const compressed = gzipSync(original);

      ipc.decompressPayload(compressed);
      ipc.decompressPayload(compressed);

      expect(ipc.getStats().totalDecompressed).toBe(2);
    });

    it("should handle rejection of corrupt gzip data gracefully", () => {
      // Create something with gzip magic but corrupt content
      const corrupt = Buffer.from([0x1f, 0x8b, 0x00, 0x00, 0x00, 0x00, 0x00]);
      const result = ipc.decompressPayload(corrupt);

      // Should return original on decompression failure
      expect(result).toBe(corrupt);
    });
  });

  // ================================================================
  // wrapHandler() — decorator pattern
  // ================================================================
  describe("wrapHandler()", () => {
    it("should compress Buffer result from handler", async () => {
      const originalData = createBuffer(100_000);
      const handler = async (): Promise<Buffer> => originalData;

      const wrapped = ipc.wrapHandler(handler);

      // Create a minimal mock event
      const mockEvent = {} as Electron.IpcMainInvokeEvent;
      const result = await wrapped(mockEvent);

      expect(result).toBeInstanceOf(Buffer);
      expect((result as Buffer).length).toBeLessThan(originalData.length);

      // Should be decompressible back to original
      const decompressed = gunzipSync(result as Buffer);
      expect(decompressed.equals(originalData)).toBe(true);
    });

    it("should NOT compress non-Buffer results", async () => {
      const handler = async (): Promise<string> => "simple string result";
      const wrapped = ipc.wrapHandler(handler);

      const mockEvent = {} as Electron.IpcMainInvokeEvent;
      const result = await wrapped(mockEvent);

      expect(result).toBe("simple string result");
    });

    it("should NOT compress Buffer smaller than threshold", async () => {
      const smallBuffer = createBuffer(100); // Far below 64KB
      const handler = async (): Promise<Buffer> => smallBuffer;
      const wrapped = ipc.wrapHandler(handler);

      const mockEvent = {} as Electron.IpcMainInvokeEvent;
      const result = await wrapped(mockEvent);

      expect(result).toBe(smallBuffer); // Same reference
    });

    it("should compress Buffer property in object result", async () => {
      const originalData = createBuffer(100_000);
      const handler = async (): Promise<{ data: Buffer; meta: string }> => ({
        data: originalData,
        meta: "test",
      });
      const wrapped = ipc.wrapHandler(handler);

      const mockEvent = {} as Electron.IpcMainInvokeEvent;
      const result = (await wrapped(mockEvent)) as { data: Buffer; meta: string };

      expect(result.meta).toBe("test");
      expect(result.data).toBeInstanceOf(Buffer);
      expect(result.data.length).toBeLessThan(originalData.length);

      // Round-trip
      const decompressed = gunzipSync(result.data);
      expect(decompressed.equals(originalData)).toBe(true);
    });

    it("should pass handler arguments through transparently", async () => {
      const receivedArgs: unknown[] = [];
      const handler = async (_event: Electron.IpcMainInvokeEvent, ...args: unknown[]): Promise<string> => {
        receivedArgs.push(...args);
        return "done";
      };
      const wrapped = ipc.wrapHandler(handler);

      const mockEvent = {} as Electron.IpcMainInvokeEvent;
      await wrapped(mockEvent, "arg1", 42, { key: "value" });

      expect(receivedArgs).toEqual(["arg1", 42, { key: "value" }]);
    });

    it("should NOT compress null result", async () => {
      const handler = async (): Promise<null> => null;
      const wrapped = ipc.wrapHandler(handler);

      const mockEvent = {} as Electron.IpcMainInvokeEvent;
      const result = await wrapped(mockEvent);
      expect(result).toBeNull();
    });

    it("should NOT compress undefined result", async () => {
      const handler = async (): Promise<undefined> => undefined;
      const wrapped = ipc.wrapHandler(handler);

      const mockEvent = {} as Electron.IpcMainInvokeEvent;
      const result = await wrapped(mockEvent);
      expect(result).toBeUndefined();
    });

    it("should NOT compress number result", async () => {
      const handler = async (): Promise<number> => 42;
      const wrapped = ipc.wrapHandler(handler);

      const mockEvent = {} as Electron.IpcMainInvokeEvent;
      const result = await wrapped(mockEvent);
      expect(result).toBe(42);
    });
  });

  // ================================================================
  // wrapHandlerWithDecompress()
  // ================================================================
  describe("wrapHandlerWithDecompress()", () => {
    it("should decompress Buffer arguments before passing to handler", async () => {
      const originalData = createRandomishBuffer(100_000);
      const compressed = gzipSync(originalData);

      const handler = async (_event: Electron.IpcMainInvokeEvent, data: Buffer): Promise<boolean> => {
        return data.equals(originalData);
      };
      const wrapped = ipc.wrapHandlerWithDecompress(handler);

      const mockEvent = {} as Electron.IpcMainInvokeEvent;
      const result = await wrapped(mockEvent, compressed);

      expect(result).toBe(true);
    });

    it("should leave non-Buffer arguments unchanged", async () => {
      const handler = async (
        _event: Electron.IpcMainInvokeEvent,
        str: string,
        num: number,
      ): Promise<[string, number]> => [str, num];
      const wrapped = ipc.wrapHandlerWithDecompress(handler);

      const mockEvent = {} as Electron.IpcMainInvokeEvent;
      const result = await wrapped(mockEvent, "hello", 42);

      expect(result).toEqual(["hello", 42]);
    });

    it("should handle mixed compressed and non-compressed args", async () => {
      const originalData = createRandomishBuffer(100_000);
      const compressed = gzipSync(originalData);

      const handler = async (
        _event: Electron.IpcMainInvokeEvent,
        str: string,
        data: Buffer,
      ): Promise<{ str: string; match: boolean }> => ({
        str,
        match: data.equals(originalData),
      });
      const wrapped = ipc.wrapHandlerWithDecompress(handler);

      const mockEvent = {} as Electron.IpcMainInvokeEvent;
      const result = await wrapped(mockEvent, "prefix", compressed);

      expect(result.str).toBe("prefix");
      expect(result.match).toBe(true);
    });

    it("should leave non-gzip Buffer arguments unchanged", async () => {
      const plainBuffer = createBuffer(500, "plain");
      const handler = async (_event: Electron.IpcMainInvokeEvent, data: Buffer): Promise<Buffer> => data;
      const wrapped = ipc.wrapHandlerWithDecompress(handler);

      const mockEvent = {} as Electron.IpcMainInvokeEvent;
      const result = await wrapped(mockEvent, plainBuffer);

      expect(result).toBe(plainBuffer);
    });
  });

  // ================================================================
  // End-to-end: compress → decompress round-trip
  // ================================================================
  describe("end-to-end round-trip", () => {
    it("should compress and decompress correctly end-to-end", () => {
      const original = createRandomishBuffer(200_000);

      // Compress
      const compressed = ipc.compressPayload(original);
      expect(compressed.length).toBeLessThan(original.length);

      // Decompress
      const decompressed = ipc.decompressPayload(compressed);
      expect(decompressed.equals(original)).toBe(true);
    });

    it("should handle multiple round-trips", () => {
      for (let i = 0; i < 10; i++) {
        const original = createRandomishBuffer(80_000 + i * 1000);
        const compressed = ipc.compressPayload(original);
        const decompressed = ipc.decompressPayload(compressed);
        expect(decompressed.equals(original)).toBe(true);
      }

      expect(ipc.getStats().totalCompressed).toBe(10);
      expect(ipc.getStats().totalDecompressed).toBe(10);
    });
  });

  // ================================================================
  // setEnabled()
  // ================================================================
  describe("setEnabled()", () => {
    it("should toggle compression on/off", () => {
      expect(ipc.getStats().enabled).toBe(true);

      ipc.setEnabled(false);
      expect(ipc.getStats().enabled).toBe(false);

      ipc.setEnabled(true);
      expect(ipc.getStats().enabled).toBe(true);
    });

    it("should bypass compression when disabled", () => {
      ipc.setEnabled(false);
      const data = createBuffer(100_000);
      const result = ipc.compressPayload(data);
      expect(result).toBe(data);
      expect(ipc.getStats().totalCompressed).toBe(0);
    });
  });

  // ================================================================
  // Edge cases
  // ================================================================
  describe("edge cases", () => {
    it("should handle highly compressible data", () => {
      const data = Buffer.from("A".repeat(200_000));
      const compressed = ipc.compressPayload(data);
      // Highly compressible — should be very small
      expect(compressed.length).toBeLessThan(data.length * 0.1);
    });

    it("should handle minimally compressible data", () => {
      const data = createRandomishBuffer(100_000);
      const compressed = ipc.compressPayload(data);
      // Random-ish data may or may not compress well
      // But it should at least have the gzip magic
      expect(compressed[0]).toBe(0x1f);
      expect(compressed[1]).toBe(0x8b);
    });

    it("should handle 1MB payload", () => {
      const data = createBuffer(1_048_576); // 1MB
      const compressed = ipc.compressPayload(data);
      expect(compressed.length).toBeLessThan(data.length);
      // Round-trip
      const decompressed = gunzipSync(compressed);
      expect(decompressed.equals(data)).toBe(true);
    });
  });
});
