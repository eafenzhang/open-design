import type { Configuration } from "electron-builder";

/**
 * Open Design — Electron Builder Configuration
 *
 * Windows NSIS configuration with code signing support.
 * Signing fields use environment variables for CI/CD integration:
 *   - CODESIGN_CERTIFICATE_FILE: path to .pfx/.p12 certificate
 *   - CODESIGN_CERT_PASSWORD: certificate password
 *   - CODESIGN_TIMESTAMP_SERVER: RFC 3161 timestamp server (default: DigiCert)
 */

const CERTIFICATE_FILE: string =
  process.env["CODESIGN_CERTIFICATE_FILE"] ?? "";
const CERTIFICATE_PASSWORD: string =
  process.env["CODESIGN_CERT_PASSWORD"] ?? "";
const TIMESTAMP_SERVER: string =
  process.env["CODESIGN_TIMESTAMP_SERVER"] ?? "http://timestamp.digicert.com";

const hasSigningConfig: boolean =
  CERTIFICATE_FILE.length > 0 && CERTIFICATE_PASSWORD.length > 0;

const config: Configuration = {
  appId: "com.open-design.desktop",
  productName: "Open Design",
  copyright: "Copyright © 2025 Open Design Contributors",

  directories: {
    output: "dist",
    buildResources: "build",
    app: "../packaged",
  },

  files: [
    "src/**/*",
    "package.json",
  ],

  extraMetadata: {
    main: "./src/index.js",
  },

  win: {
    target: [
      {
        target: "nsis",
        arch: ["x64"],
      },
    ],
    icon: "build/icon.ico",

    // Code signing configuration for the packaged executable
    ...(hasSigningConfig
      ? {
          sign: "./scripts/windows-code-sign.ps1",
          signAndEditExecutable: true,
          certificateFile: CERTIFICATE_FILE,
          certificatePassword: CERTIFICATE_PASSWORD,
          signingHashAlgorithms: ["sha256"],
          rfc3161TimeStampServer: TIMESTAMP_SERVER,
        }
      : {}),
  },

  nsis: {
    oneClick: false,
    perMachine: true,
    allowToChangeInstallationDirectory: true,
    license: "LICENSE",
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: "Open Design",
    installerIcon: "build/icon.ico",
    uninstallerIcon: "build/icon.ico",
    installerHeaderIcon: "build/icon.ico",

    // NSIS compression for reduced installer size
    differentialPackage: false,
    deleteAppDataOnUninstall: false,

    // Code signing for the NSIS installer stub
    ...(hasSigningConfig
      ? {
          signAndEditExecutable: true,
        }
      : {}),
  },

  // Publish configuration
  publish: [
    {
      provider: "github",
      owner: "open-design",
      repo: "open-design",
      releaseType: "draft",
    },
  ],

  // ASAR packaging for performance
  asar: true,
  asarUnpack: [
    "**/*.node",
    "**/better-sqlite3/**",
  ],

  // Compression
  compression: "maximum",

  // Include native add-ons
  nodeGypRebuild: true,
  npmRebuild: true,
};

export default config;
