/**
 * Unit tests for UpdaterHealthCheck — payload verification,
 * backup creation, rollback, self-health checks, and error handling.
 *
 * Uses temporary files for real file-system operations.
 *
 * @module apps/packaged/src/__tests__/updater-health-check
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import {
  UpdaterHealthCheck,
  UpdaterState,
  UpdaterError,
} from "../updater-health-check.js";

describe("UpdaterHealthCheck", () => {
  let tmpDir: string;
  let updater: UpdaterHealthCheck;
  let asarPath: string;
  let backupPath: string;

  beforeEach(async () => {
    // Create temp directory
    tmpDir = nodePath.join(
      os.tmpdir(),
      `open-design-updater-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );

    await fs.mkdir(tmpDir, { recursive: true });

    asarPath = nodePath.join(tmpDir, "app.asar");
    backupPath = nodePath.join(tmpDir, "app.asar.backup");

    // Create a test "asar" file with known content
    const testContent = Buffer.from("test-asar-content-" + Date.now());
    await fs.writeFile(asarPath, testContent);

    updater = new UpdaterHealthCheck({
      currentAsarPath: asarPath,
      backupAsarPath: backupPath,
      logDir: tmpDir,
      healthCheckTimeoutMs: 5_000,
    });

    await updater.initLogging();
  });

  afterEach(async () => {
    try {
      await updater.closeLogging();
    } catch {
      // Ignore
    }

    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup failures
    }
  });

  // ================================================================
  // verifyPayload()
  // ================================================================
  describe("verifyPayload()", () => {
    it("should verify matching checksums", async () => {
      const content = await fs.readFile(asarPath);
      const checksum = crypto
        .createHash("sha256")
        .update(content)
        .digest("hex");

      const valid = await updater.verifyPayload(asarPath, checksum);
      expect(valid).toBe(true);
      expect(updater.getState()).toBe(UpdaterState.VERIFYING);
    });

    it("should throw UpdaterError on checksum mismatch", async () => {
      const wrongChecksum =
        "0000000000000000000000000000000000000000000000000000000000000000";

      await expect(
        updater.verifyPayload(asarPath, wrongChecksum),
      ).rejects.toThrow(UpdaterError);

      try {
        await updater.verifyPayload(asarPath, wrongChecksum);
        expect.unreachable("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(UpdaterError);
        expect((err as UpdaterError).code).toBe("CHECKSUM_MISMATCH");
      }
    });

    it("should throw UpdaterError for non-existent files", async () => {
      const nonExistentPath = nodePath.join(tmpDir, "does-not-exist.asar");

      await expect(
        updater.verifyPayload(nonExistentPath, "any-checksum"),
      ).rejects.toThrow(UpdaterError);
    });

    it("should be case-insensitive for checksum comparison", async () => {
      const content = await fs.readFile(asarPath);
      const checksum = crypto
        .createHash("sha256")
        .update(content)
        .digest("hex");

      const upperChecksum = checksum.toUpperCase();

      const valid = await updater.verifyPayload(asarPath, upperChecksum);
      expect(valid).toBe(true);
    });
  });

  // ================================================================
  // createBackup()
  // ================================================================
  describe("createBackup()", () => {
    it("should create a backup of the asar file", async () => {
      await updater.createBackup();

      const backupExists = await fs
        .stat(backupPath)
        .then(() => true)
        .catch(() => false);
      expect(backupExists).toBe(true);

      expect(updater.getState()).toBe(UpdaterState.INSTALLING);
    });

    it("should create a bit-identical backup", async () => {
      await updater.createBackup();

      const original = await fs.readFile(asarPath);
      const backup = await fs.readFile(backupPath);

      expect(original.equals(backup)).toBe(true);
    });

    it("should create parent directories if needed", async () => {
      const nestedBackup = nodePath.join(tmpDir, "subdir", "nested", "app.asar.backup");
      const nestedUpdater = new UpdaterHealthCheck({
        currentAsarPath: asarPath,
        backupAsarPath: nestedBackup,
        logDir: tmpDir,
      });

      await nestedUpdater.createBackup();

      const exists = await fs
        .stat(nestedBackup)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);

      await nestedUpdater.closeLogging();
    });

    it("should throw UpdaterError if current asar does not exist", async () => {
      const badUpdater = new UpdaterHealthCheck({
        currentAsarPath: nodePath.join(tmpDir, "no-such-file.asar"),
        backupAsarPath: backupPath,
        logDir: tmpDir,
      });

      await expect(badUpdater.createBackup()).rejects.toThrow(UpdaterError);
      await badUpdater.closeLogging();
    });
  });

  // ================================================================
  // rollback()
  // ================================================================
  describe("rollback()", () => {
    it("should restore backup over current asar", async () => {
      // Create backup first
      await updater.createBackup();

      // Modify the current asar (simulating a broken update)
      await fs.writeFile(asarPath, "broken-content");

      // Rollback
      await updater.rollback();

      // Current asar should match original backup content
      const current = await fs.readFile(asarPath);
      const backup = await fs.readFile(backupPath);

      expect(current.equals(backup)).toBe(true);
      expect(updater.getState()).toBe(UpdaterState.ROLLBACK);
    });

    it("should throw UpdaterError if backup does not exist", async () => {
      await expect(updater.rollback()).rejects.toThrow(UpdaterError);
    });
  });

  // ================================================================
  // cleanupBackup()
  // ================================================================
  describe("cleanupBackup()", () => {
    it("should remove the backup file", async () => {
      await updater.createBackup();

      await updater.cleanupBackup();

      const backupExists = await fs
        .stat(backupPath)
        .then(() => true)
        .catch(() => false);
      expect(backupExists).toBe(false);
    });

    it("should not throw if backup already deleted", async () => {
      // No backup exists
      await expect(updater.cleanupBackup()).resolves.toBeUndefined();
    });
  });

  // ================================================================
  // isHealthy()
  // ================================================================
  describe("isHealthy()", () => {
    it("should return true when asar exists", async () => {
      const healthy = await updater.isHealthy();
      expect(healthy).toBe(true);
      expect(updater.getIsHealthy()).toBe(true);
    });

    it("should return false when asar does not exist", async () => {
      // Delete the asar file
      await fs.unlink(asarPath);

      const healthy = await updater.isHealthy();
      expect(healthy).toBe(false);
      expect(updater.getIsHealthy()).toBe(false);
    });

    it("should check IPC connectivity when ipcCheckFn is provided", async () => {
      const ipcCheckFn = async (): Promise<boolean> => true;
      const healthy = await updater.isHealthy(ipcCheckFn);
      expect(healthy).toBe(true);
    });

    it("should report unhealthy when IPC check fails", async () => {
      const ipcCheckFn = async (): Promise<boolean> => false;
      const healthy = await updater.isHealthy(ipcCheckFn);
      expect(healthy).toBe(false);
    });
  });

  // ================================================================
  // State management
  // ================================================================
  describe("state management", () => {
    it("should start in IDLE state", () => {
      expect(updater.getState()).toBe(UpdaterState.IDLE);
    });

    it("should reset state to IDLE", () => {
      updater.resetState();
      expect(updater.getState()).toBe(UpdaterState.IDLE);
    });

    it("should track getIsHealthy after health check", async () => {
      await updater.isHealthy();
      expect(updater.getIsHealthy()).toBe(true);
    });
  });

  // ================================================================
  // Full update lifecycle
  // ================================================================
  describe("full update lifecycle", () => {
    it("should handle backup → verify failure → rollback gracefully", async () => {
      // Step 1: Create backup
      await updater.createBackup();
      expect(updater.getState()).toBe(UpdaterState.INSTALLING);

      // Step 2: Simulate update failure by modifying asar with bad content
      await fs.writeFile(asarPath, "corrupted-update");

      // Step 3: Rollback
      await updater.rollback();
      expect(updater.getState()).toBe(UpdaterState.ROLLBACK);

      // Step 4: Verify restored content matches backup
      const current = await fs.readFile(asarPath);
      const backup = await fs.readFile(backupPath);
      expect(current.equals(backup)).toBe(true);
    });
  });
});
