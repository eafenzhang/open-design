/**
 * Open Design — GPU Capability Types
 *
 * Defines the GPU capability detection model, tier classification,
 * and ANGLE backend selection for Windows hardware acceleration.
 *
 * @module types/gpu-capability
 */

/** GPU capability tier: determines which acceleration strategy to apply. */
export enum GpuTier {
  /** GPU is known-good; full hardware acceleration enabled. */
  WHITELIST = "WHITELIST",

  /** GPU has partial issues; selective acceleration with workarounds. */
  GREYLIST = "GREYLIST",

  /** GPU is in Chromium denylist; software rendering only. */
  BLACKLIST = "BLACKLIST",
}

/** ANGLE (Almost Native Graphics Layer Engine) backend options for Windows. */
export enum AngleBackend {
  /** Direct3D 11 — preferred on modern Windows (Win8+). */
  D3D11 = "D3D11",

  /** Direct3D 9 — fallback for older GPUs/drivers. */
  D3D9 = "D3D9",

  /** Windows Advanced Rasterization Platform — CPU software rendering. */
  WARP = "WARP",

  /** Let Chromium auto-select the ANGLE backend. */
  DEFAULT = "DEFAULT",
}

/**
 * Result of GPU capability detection.
 * Contains the tier classification, hardware details,
 * Chromium denylist matches, and recommended command-line switches.
 */
export interface GpuCapability {
  /** The determined capability tier for this GPU. */
  tier: GpuTier;

  /** GPU vendor string (e.g., "NVIDIA", "Intel", "AMD"). */
  vendor: string;

  /** GPU renderer string (e.g., "ANGLE (NVIDIA GeForce RTX 4070 Direct3D11)"). */
  renderer: string;

  /** List of Chromium denylist entries that matched this GPU. */
  chromiumDenylist: string[];

  /** Selected ANGLE backend based on tier and driver. */
  angleBackend: AngleBackend;

  /** Chromium GPU feature status map (feature name → status string). */
  featureStatus: Record<string, string>;

  /** Recommended Chromium command-line switches for this GPU. */
  recommendedSwitches: string[];
}

/**
 * Default capability for when GPU detection fails entirely.
 * Falls back to BLACKLIST tier with WARP software rendering.
 */
export const DEFAULT_GPU_CAPABILITY: GpuCapability = {
  tier: GpuTier.BLACKLIST,
  vendor: "unknown",
  renderer: "unknown",
  chromiumDenylist: [],
  angleBackend: AngleBackend.WARP,
  featureStatus: {},
  recommendedSwitches: [
    "--disable-gpu",
    "--disable-gpu-compositing",
    "--disable-accelerated-2d-canvas",
    "--disable-accelerated-video-decode",
  ],
};

/** Chromium denylist entries that indicate a GPU should be blacklisted. */
const BLACKLIST_INDICATORS: readonly string[] = [
  "software_rendering",
  "gpu_rendering",
  "all_rendering",
  "disable_all_gpu",
];

/** Check if a denylist entry should trigger BLACKLIST tier. */
export function isBlacklistSevere(entries: string[]): boolean {
  return entries.some((entry) =>
    BLACKLIST_INDICATORS.some((indicator) =>
      entry.toLowerCase().includes(indicator),
    ),
  );
}
