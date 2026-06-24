/**
 * Open Design — GPU Detector
 *
 * Detects GPU capabilities on Windows and applies appropriate
 * Chromium command-line switches for hardware acceleration.
 *
 * Three-tier strategy:
 *   1. WHITELIST  → Enable full GPU acceleration
 *   2. GREYLIST   → Selective acceleration with ANGLE workarounds
 *   3. BLACKLIST  → Software rendering (WARP) only
 *
 * @module gpu-detector
 */

import {
  AngleBackend,
  GpuTier,
  type GpuCapability,
  DEFAULT_GPU_CAPABILITY,
  isBlacklistSevere,
} from "./types/gpu-capability.js";

/** Log prefix for this module. */
const LOG_PREFIX = "[OpenDesign:GpuDetector]";

/**
 * Raw GPU information returned by Electron's app.getGPUInfo().
 * Shape may vary across Electron versions; this captures the key fields.
 */
interface ElectronGpuInfo {
  gpuDevice: Array<{
    deviceId: number;
    vendorId: number;
    vendorString: string;
    deviceString: string;
    driverVendor: string;
    driverVersion: string;
  }>;
  auxAttributes?: Record<string, unknown>;
  featureStatus?: Record<string, string>;
}

/**
 * GPU detector for Windows hardware acceleration.
 *
 * Uses Electron's app.getGPUInfo('complete') and getGPUFeatureStatus()
 * APIs to determine whether the current GPU is safe for hardware
 * acceleration, and generates appropriate Chromium flags.
 */
export class GpuDetector {
  /** Known-good GPU vendor substrings (case-insensitive). */
  private static readonly WHITELIST_VENDORS: readonly string[] = [
    "nvidia",
    "amd",
    "ati",
    "intel",
  ];

  /** Known-bad GPU renderer substrings (case-insensitive). */
  private static readonly BLACKLIST_RENDERERS: readonly string[] = [
    "microsoft basic render driver",
    "vmware svga",
    "virtualbox graphics",
    "llvmpipe",
    "softpipe",
    "gdi generic",
  ];

  /** Proxy for Electron app instance (injected for testability). */
  private readonly _electronApp: ElectronAppProxy | null;

  /**
   * @param electronApp - Electron app proxy for GPU info queries.
   *   If null, falls back to safe defaults.
   */
  constructor(electronApp: ElectronAppProxy | null = null) {
    this._electronApp = electronApp;
  }

  /**
   * Detect GPU capability and determine the appropriate acceleration tier.
   *
   * @returns Promise resolving to GpuCapability with tier and recommended switches.
   */
  async detect(): Promise<GpuCapability> {
    try {
      const gpuInfo: ElectronGpuInfo | null = await this._queryChromiumGpuInfo();
      if (!gpuInfo || !gpuInfo.gpuDevice || gpuInfo.gpuDevice.length === 0) {
        console.warn(
          `${LOG_PREFIX} No GPU devices detected. Falling back to BLACKLIST.`,
        );
        return this._buildCapability(DEFAULT_GPU_CAPABILITY);
      }

      const primaryDevice = gpuInfo.gpuDevice[0]!;
      const vendor: string = primaryDevice.vendorString ?? "unknown";
      const renderer: string = primaryDevice.deviceString ?? "unknown";

      const denylist: string[] = this._checkDenylist(gpuInfo);
      const tier: GpuTier = this._determineTier(denylist, vendor, renderer);
      const angleBackend: AngleBackend = this._selectAngleBackend(tier);
      const featureStatus: Record<string, string> =
        gpuInfo.featureStatus ?? {};

      const capability: GpuCapability = {
        tier,
        vendor,
        renderer,
        chromiumDenylist: denylist,
        angleBackend,
        featureStatus,
        recommendedSwitches: [],
      };

      capability.recommendedSwitches = this._buildSwitches(capability);

      console.info(
        `${LOG_PREFIX} GPU detection complete: tier=${tier}, ` +
          `vendor=${vendor}, renderer=${renderer}, ` +
          `denylist=[${denylist.join(", ")}], ` +
          `angleBackend=${angleBackend}`,
      );

      return capability;
    } catch (err) {
      console.error(`${LOG_PREFIX} GPU detection failed:`, err);
      return { ...DEFAULT_GPU_CAPABILITY };
    }
  }

  /**
   * Apply the recommended Chromium command-line switches for a GPU capability.
   *
   * Must be called BEFORE app.whenReady() / before creating any BrowserWindow.
   *
   * @param capability - The GpuCapability from detect().
   */
  applySwitches(capability: GpuCapability): void {
    if (!this._electronApp || !this._electronApp.commandLine) {
      console.warn(
        `${LOG_PREFIX} Cannot apply switches: Electron app.commandLine not available.`,
      );
      return;
    }

    const switches: string[] = capability.recommendedSwitches;

    for (const sw of switches) {
      // Switches are in the form "--flag" or "--flag=value"
      const eqIndex: number = sw.indexOf("=");
      if (eqIndex > 0) {
        const flag: string = sw.substring(2, eqIndex);
        const value: string = sw.substring(eqIndex + 1);
        this._electronApp.commandLine.appendSwitch(flag, value);
      } else {
        const flag: string = sw.substring(2);
        this._electronApp.commandLine.appendSwitch(flag);
      }

      console.info(`${LOG_PREFIX} Applied switch: ${sw}`);
    }
  }

  // ================================================================
  // Private methods
  // ================================================================

  /** Query Chromium GPU info via Electron app API. */
  private async _queryChromiumGpuInfo(): Promise<ElectronGpuInfo | null> {
    if (!this._electronApp) {
      return null;
    }

    try {
      const info: ElectronGpuInfo =
        await this._electronApp.getGPUInfo("complete");
      return info;
    } catch {
      console.warn(
        `${LOG_PREFIX} app.getGPUInfo() failed. Using safe defaults.`,
      );
      return null;
    }
  }

  /** Check GPU against Chromium denylist patterns. */
  private _checkDenylist(gpuInfo: ElectronGpuInfo): string[] {
    const denylist: string[] = [];

    if (!gpuInfo.featureStatus) {
      return denylist;
    }

    // Check feature status for disabled/problematic features
    for (const [feature, status] of Object.entries(gpuInfo.featureStatus)) {
      const statusLower: string = status.toLowerCase();
      if (
        statusLower.includes("disabled") ||
        statusLower.includes("unavailable") ||
        statusLower.includes("software")
      ) {
        denylist.push(feature);
      }
    }

    return denylist;
  }

  /** Determine GPU tier based on denylist + vendor/renderer heuristics. */
  private _determineTier(
    denylist: string[],
    vendor: string,
    renderer: string,
  ): GpuTier {
    // Check renderer against blacklist patterns
    const vendorLower: string = vendor.toLowerCase();
    const rendererLower: string = renderer.toLowerCase();

    const isKnownBad: boolean = GpuDetector.BLACKLIST_RENDERERS.some((bad) =>
      rendererLower.includes(bad),
    );

    if (isKnownBad) {
      return GpuTier.BLACKLIST;
    }

    // Check denylist severity
    if (isBlacklistSevere(denylist)) {
      return GpuTier.BLACKLIST;
    }

    // Check if vendor is recognized
    const isKnownGood: boolean = GpuDetector.WHITELIST_VENDORS.some((good) =>
      vendorLower.includes(good),
    );

    if (!isKnownGood) {
      return GpuTier.GREYLIST;
    }

    // If denylist has entries but they're not severe, use GREYLIST
    if (denylist.length > 0) {
      return GpuTier.GREYLIST;
    }

    // Clean GPU → WHITELIST
    return GpuTier.WHITELIST;
  }

  /** Select the appropriate ANGLE backend based on GPU tier. */
  private _selectAngleBackend(tier: GpuTier): AngleBackend {
    switch (tier) {
      case GpuTier.WHITELIST:
        return AngleBackend.D3D11;
      case GpuTier.GREYLIST:
        return AngleBackend.D3D9;
      case GpuTier.BLACKLIST:
        return AngleBackend.WARP;
      default:
        return AngleBackend.DEFAULT;
    }
  }

  /** Build Chromium command-line switches for a given capability. */
  private _buildSwitches(capability: GpuCapability): string[] {
    const switches: string[] = [];
    const { tier, angleBackend } = capability;

    switch (tier) {
      case GpuTier.WHITELIST:
        // Full acceleration
        switches.push("--enable-gpu");
        switches.push("--enable-accelerated-2d-canvas");
        switches.push("--enable-accelerated-video-decode");
        switches.push("--enable-native-gpu-memory-buffers");
        switches.push("--enable-zero-copy");
        switches.push(`--use-gl=angle`);
        switches.push(`--use-angle=${angleBackend.toLowerCase()}`);
        break;

      case GpuTier.GREYLIST:
        // Selective acceleration with workarounds
        switches.push("--enable-gpu");
        switches.push("--disable-gpu-driver-bug-workarounds");
        switches.push("--enable-accelerated-2d-canvas");
        switches.push(`--use-gl=angle`);
        switches.push(`--use-angle=${angleBackend.toLowerCase()}`);
        // Disable potentially problematic features
        switches.push("--disable-accelerated-video-decode");
        switches.push("--disable-accelerated-video-encode");
        break;

      case GpuTier.BLACKLIST:
      default:
        // Software rendering only
        switches.push("--disable-gpu");
        switches.push("--disable-gpu-compositing");
        switches.push("--disable-accelerated-2d-canvas");
        switches.push("--disable-accelerated-video-decode");
        switches.push("--disable-accelerated-video-encode");
        switches.push("--disable-webgl");
        switches.push(`--use-gl=angle`);
        switches.push(`--use-angle=${angleBackend.toLowerCase()}`);
        break;
    }

    return switches;
  }

  /** Build capability from defaults (used as fallback). */
  private _buildCapability(base: GpuCapability): GpuCapability {
    return {
      ...base,
      recommendedSwitches: this._buildSwitches(base),
    };
  }
}

/**
 * Minimal proxy interface for Electron's `app` module.
 * Allows GpuDetector to be tested without a full Electron runtime.
 */
export interface ElectronAppProxy {
  commandLine: {
    appendSwitch(flag: string, value?: string): void;
    appendArgument(value: string): void;
  };
  getGPUInfo(type: string): Promise<ElectronGpuInfo>;
}

export default GpuDetector;
