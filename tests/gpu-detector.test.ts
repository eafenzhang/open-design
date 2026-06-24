/**
 * Unit tests for GpuDetector — GPU capability detection,
 * tier classification, ANGLE backend selection, and Chromium switch generation.
 *
 * Tests use mocked Electron app proxy to avoid requiring Electron runtime.
 *
 * @module tests/unit/gpu-detector
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  GpuDetector,
  type ElectronAppProxy,
} from "../../apps/packaged/src/gpu-detector.js";
import { GpuTier, AngleBackend } from "../../apps/packaged/src/types/gpu-capability.js";
import type { GpuCapability } from "../../apps/packaged/src/types/gpu-capability.js";

/** Helper to create a mock Electron app proxy for testing. */
function createMockApp(overrides: Partial<ElectronAppProxy> = {}): ElectronAppProxy {
  const appendedSwitches: Array<{ flag: string; value?: string }> = [];

  return {
    commandLine: {
      appendSwitch(flag: string, value?: string): void {
        appendedSwitches.push({ flag, value });
      },
      appendArgument(_value: string): void {
        // no-op for testing
      },
    },
    getGPUInfo: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

/** Create a GPU info object for a known-good NVIDIA GPU. */
function nvidiaGpuInfo(): Record<string, unknown> {
  return {
    gpuDevice: [
      {
        deviceId: 0x2786,
        vendorId: 0x10de,
        vendorString: "NVIDIA",
        deviceString: "ANGLE (NVIDIA GeForce RTX 4070 Direct3D11)",
        driverVendor: "NVIDIA",
        driverVersion: "31.0.15.3742",
      },
    ],
    featureStatus: {
      "2d_canvas": "enabled",
      "gpu_compositing": "enabled",
      "multiple_raster_threads": "enabled_on",
      "opengl": "enabled",
      "rasterization": "enabled",
      "video_decode": "enabled",
      "video_encode": "enabled",
      "webgl": "enabled",
      "webgl2": "enabled",
    },
  };
}

/** Create a GPU info object for a blacklisted GPU. */
function blacklistedGpuInfo(): Record<string, unknown> {
  return {
    gpuDevice: [
      {
        deviceId: 0x0000,
        vendorId: 0x0000,
        vendorString: "Microsoft",
        deviceString: "Microsoft Basic Render Driver",
        driverVendor: "Microsoft",
        driverVersion: "10.0",
      },
    ],
    featureStatus: {
      "2d_canvas": "disabled_software",
      "gpu_compositing": "disabled_software",
      "multiple_raster_threads": "unavailable",
      "opengl": "disabled",
      "rasterization": "software",
      "video_decode": "unavailable",
      "video_encode": "unavailable",
      "webgl": "disabled",
      "webgl2": "disabled",
    },
  };
}

/** Create a GPU info object for a greylisted GPU (some features disabled). */
function greylistedGpuInfo(): Record<string, unknown> {
  return {
    gpuDevice: [
      {
        deviceId: 0x5916,
        vendorId: 0x8086,
        vendorString: "Intel",
        deviceString: "ANGLE (Intel HD Graphics 620 Direct3D11)",
        driverVendor: "Intel",
        driverVersion: "27.20.100.9316",
      },
    ],
    featureStatus: {
      "2d_canvas": "enabled",
      "gpu_compositing": "enabled",
      "multiple_raster_threads": "enabled_on",
      "opengl": "enabled",
      "rasterization": "enabled",
      "video_decode": "disabled", // partial failure
      "video_encode": "disabled", // partial failure
      "webgl": "enabled",
      "webgl2": "enabled",
    },
  };
}

describe("GpuDetector", () => {
  let detector: GpuDetector;

  describe("detect() — WHITELIST", () => {
    it("should classify NVIDIA GPU as WHITELIST", async () => {
      const mockApp = createMockApp({
        getGPUInfo: vi.fn().mockResolvedValue(nvidiaGpuInfo()),
      });
      detector = new GpuDetector(mockApp);

      const cap: GpuCapability = await detector.detect();

      expect(cap.tier).toBe(GpuTier.WHITELIST);
      expect(cap.vendor.toLowerCase()).toContain("nvidia");
      expect(cap.angleBackend).toBe(AngleBackend.D3D11);
    });

    it("should include full acceleration switches for WHITELIST", async () => {
      const mockApp = createMockApp({
        getGPUInfo: vi.fn().mockResolvedValue(nvidiaGpuInfo()),
      });
      detector = new GpuDetector(mockApp);

      const cap: GpuCapability = await detector.detect();

      expect(cap.recommendedSwitches).toContain("--enable-gpu");
      expect(cap.recommendedSwitches).toContain("--use-gl=angle");
      expect(cap.recommendedSwitches).toContain("--use-angle=d3d11");
      expect(cap.recommendedSwitches).not.toContain("--disable-gpu");
    });
  });

  describe("detect() — BLACKLIST", () => {
    it("should classify Microsoft Basic Render Driver as BLACKLIST", async () => {
      const mockApp = createMockApp({
        getGPUInfo: vi.fn().mockResolvedValue(blacklistedGpuInfo()),
      });
      detector = new GpuDetector(mockApp);

      const cap: GpuCapability = await detector.detect();

      expect(cap.tier).toBe(GpuTier.BLACKLIST);
      expect(cap.angleBackend).toBe(AngleBackend.WARP);
    });

    it("should include disable-gpu for BLACKLIST", async () => {
      const mockApp = createMockApp({
        getGPUInfo: vi.fn().mockResolvedValue(blacklistedGpuInfo()),
      });
      detector = new GpuDetector(mockApp);

      const cap: GpuCapability = await detector.detect();

      expect(cap.recommendedSwitches).toContain("--disable-gpu");
      expect(cap.recommendedSwitches).toContain("--disable-gpu-compositing");
      expect(cap.recommendedSwitches).toContain("--use-angle=warp");
      expect(cap.recommendedSwitches).not.toContain("--enable-gpu");
    });

    it("should blacklist VM-related renderers", async () => {
      const vmGpuInfo = {
        gpuDevice: [
          {
            deviceId: 0x0405,
            vendorId: 0x15ad,
            vendorString: "VMware",
            deviceString: "VMware SVGA 3D",
            driverVendor: "VMware",
            driverVersion: "8.17.2.0",
          },
        ],
        featureStatus: {},
      };

      const mockApp = createMockApp({
        getGPUInfo: vi.fn().mockResolvedValue(vmGpuInfo),
      });
      detector = new GpuDetector(mockApp);

      const cap: GpuCapability = await detector.detect();
      expect(cap.tier).toBe(GpuTier.BLACKLIST);
    });
  });

  describe("detect() — GREYLIST", () => {
    it("should classify GPU with partial feature failures as GREYLIST", async () => {
      const mockApp = createMockApp({
        getGPUInfo: vi.fn().mockResolvedValue(greylistedGpuInfo()),
      });
      detector = new GpuDetector(mockApp);

      const cap: GpuCapability = await detector.detect();

      expect(cap.tier).toBe(GpuTier.GREYLIST);
      expect(cap.angleBackend).toBe(AngleBackend.D3D9);
    });

    it("should include selective acceleration switches for GREYLIST", async () => {
      const mockApp = createMockApp({
        getGPUInfo: vi.fn().mockResolvedValue(greylistedGpuInfo()),
      });
      detector = new GpuDetector(mockApp);

      const cap: GpuCapability = await detector.detect();

      expect(cap.recommendedSwitches).toContain("--enable-gpu");
      expect(cap.recommendedSwitches).toContain(
        "--disable-gpu-driver-bug-workarounds",
      );
      expect(cap.recommendedSwitches).toContain(
        "--disable-accelerated-video-decode",
      );
      expect(cap.recommendedSwitches).toContain("--use-gl=angle");
      expect(cap.recommendedSwitches).toContain("--use-angle=d3d9");
    });
  });

  describe("detect() — edge cases", () => {
    it("should return BLACKLIST default when getGPUInfo fails", async () => {
      const mockApp = createMockApp({
        getGPUInfo: vi.fn().mockRejectedValue(new Error("GPU info unavailable")),
      });
      detector = new GpuDetector(mockApp);

      const cap: GpuCapability = await detector.detect();

      expect(cap.tier).toBe(GpuTier.BLACKLIST);
      expect(cap.vendor).toBe("unknown");
    });

    it("should return BLACKLIST default when no GPU devices found", async () => {
      const mockApp = createMockApp({
        getGPUInfo: vi.fn().mockResolvedValue({ gpuDevice: [], featureStatus: {} }),
      });
      detector = new GpuDetector(mockApp);

      const cap: GpuCapability = await detector.detect();

      expect(cap.tier).toBe(GpuTier.BLACKLIST);
    });

    it("should return BLACKLIST default when no Electron app proxy", async () => {
      detector = new GpuDetector(null);

      const cap: GpuCapability = await detector.detect();

      expect(cap.tier).toBe(GpuTier.BLACKLIST);
      expect(cap.vendor).toBe("unknown");
    });
  });

  describe("applySwitches()", () => {
    it("should append switches to commandLine", () => {
      const mockApp = createMockApp();
      const appendedSwitches: Array<{ flag: string; value?: string }> = [];

      // Spy on appendSwitch
      mockApp.commandLine.appendSwitch = (
        flag: string,
        value?: string,
      ): void => {
        appendedSwitches.push({ flag, value });
      };

      detector = new GpuDetector(mockApp);

      const cap: GpuCapability = {
        tier: GpuTier.WHITELIST,
        vendor: "NVIDIA",
        renderer: "Test",
        chromiumDenylist: [],
        angleBackend: AngleBackend.D3D11,
        featureStatus: {},
        recommendedSwitches: ["--enable-gpu", "--use-gl=angle", "--use-angle=d3d11"],
      };

      detector.applySwitches(cap);

      expect(appendedSwitches.length).toBe(3);
      expect(appendedSwitches[0]).toEqual({ flag: "enable-gpu", value: undefined });
      expect(appendedSwitches[1]).toEqual({ flag: "use-gl", value: "angle" });
      expect(appendedSwitches[2]).toEqual({ flag: "use-angle", value: "d3d11" });
    });

    it("should not throw when commandLine is not available", () => {
      detector = new GpuDetector(null);

      const cap: GpuCapability = {
        tier: GpuTier.WHITELIST,
        vendor: "NVIDIA",
        renderer: "Test",
        chromiumDenylist: [],
        angleBackend: AngleBackend.D3D11,
        featureStatus: {},
        recommendedSwitches: ["--enable-gpu"],
      };

      // Should not throw
      expect(() => detector.applySwitches(cap)).not.toThrow();
    });
  });

  describe("unknown vendor classification", () => {
    it("should GREYLIST unknown GPU vendors", async () => {
      const unknownVendorInfo = {
        gpuDevice: [
          {
            deviceId: 0x1234,
            vendorId: 0x5678,
            vendorString: "UnknownVendor",
            deviceString: "Unknown GPU Device",
            driverVendor: "UnknownVendor",
            driverVersion: "1.0.0",
          },
        ],
        featureStatus: {},
      };

      const mockApp = createMockApp({
        getGPUInfo: vi.fn().mockResolvedValue(unknownVendorInfo),
      });
      detector = new GpuDetector(mockApp);

      const cap: GpuCapability = await detector.detect();

      expect(cap.tier).toBe(GpuTier.GREYLIST);
    });
  });
});
