import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgres://backup-status-test.invalid/willard";

const { toBackupStatusResponse } = await import("../lib/backup-coordinator.ts");

test("backup status exposes bounded non-secret protection facts", () => {
  process.env.WILLARD_BACKUP_RECOVERY_EXPORT_READY = "1";
  process.env.WILLARD_BACKUP_PASSPHRASE = "protected-test-automation-secret";
  const status = toBackupStatusResponse({
    backupEnabled: true,
    backupScheduleHours: 24,
    backupStatus: "PROTECTED",
    backupLastAttemptAt: new Date("2026-08-28T10:00:00.000Z"),
    backupLastSuccessAt: new Date("2026-08-28T10:01:00.000Z"),
    backupLastVerifiedAt: new Date("2026-08-28T10:01:00.000Z"),
    backupLastError: null,
    nasPath: "/library",
  });

  assert.equal(status.status, "PROTECTED");
  assert.equal(status.recoveryExportReady, true);
  assert.equal(status.destinationClass, "NAS_LIBRARY");
  assert.equal(status.destinationLabel, "WillardAI/backups");
  assert.equal(status.lastVerifiedAt, "2026-08-28T10:01:00.000Z");
  assert.equal("nasPath" in status, false);
  assert.equal("credential" in status, false);
});

test("pending and invalid settings fail closed", () => {
  process.env.WILLARD_BACKUP_RECOVERY_EXPORT_READY = "1";
  process.env.WILLARD_BACKUP_PASSPHRASE = "protected-test-automation-secret";
  const pending = toBackupStatusResponse({
    backupStatus: "PENDING",
    backupScheduleHours: 999,
    backupLastError: "The NAS is offline; backup is waiting to retry.",
    nasPath: "/library",
  });
  assert.equal(pending.status, "PENDING");
  assert.equal(pending.scheduleHours, 168);
  assert.equal(pending.recoveryExportReady, true);
  assert.match(pending.pendingReason ?? "", /offline/);

  delete process.env.WILLARD_BACKUP_RECOVERY_EXPORT_READY;
  const unknown = toBackupStatusResponse({ backupStatus: "PROTECTED", nasPath: "/library" });
  assert.equal(unknown.status, "NEVER_CONFIGURED");
  assert.equal(unknown.lastSuccessAt, null);
});