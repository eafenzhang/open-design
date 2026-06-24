/// <reference types="vitest" />

/**
 * Open Design — Vitest Configuration
 *
 * Test configuration for the Open Design monorepo.
 * Configured for both unit and E2E testing scenarios.
 */

import { defineConfig } from "vitest/config";
import * as nodePath from "node:path";

export default defineConfig({
  test: {
    // Test file patterns
    include: [
      "tests/unit/**/*.test.ts",
      "apps/*/src/**/*.test.ts",
      "apps/*/src/__tests__/**/*.test.ts",
    ],

    // Exclude patterns
    exclude: [
      "node_modules/**",
      "dist/**",
      "out/**",
      ".next/**",
    ],

    // Global settings
    globals: true,

    // Environment
    environment: "node",

    // Timeouts (increased for Windows CI)
    testTimeout: 30_000,
    hookTimeout: 30_000,

    // Coverage configuration
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "lcov"],
      include: [
        "apps/packaged/src/**/*.ts",
      ],
      exclude: [
        "apps/packaged/src/types/**",
        "apps/packaged/src/__tests__/**",
      ],
      thresholds: {
        branches: 70,
        functions: 80,
        lines: 80,
        statements: 80,
      },
    },

    // Reporters
    reporters: ["verbose"],

    // Retry failed tests on CI
    retry: process.env["CI"] ? 2 : 0,
  },

  resolve: {
    alias: {
      "@open-design/platform": nodePath.resolve(
        __dirname,
        "apps/packaged/src/platform-mock.ts",
      ),
    },
  },
});
