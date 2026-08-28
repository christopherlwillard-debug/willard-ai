import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appSettingsTable, db } from "@workspace/db";
import { asc, desc, eq, isNotNull } from "drizzle-orm";
import { checkNasReachableAsync } from "./nas-storage.ts";
import { logger } from "./logger.ts";

export const BACKUP_STATUSES = [
  "NEVER_CONFIGURED",
  "PENDING",
  "PROTECTED",
  "FAILED",
] as const;
export type BackupStatus = (typeof BACKUP_STATUSES)[number];

export interface BackupStatusResponse {
  status: BackupStatus;
  enabled: boolean;
  scheduleHours: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastVerifiedAt: string | null;
  lastError: string | null;
  destinationClass: "NAS_LIBRARY";
  destinationLabel: "WillardAI/backups";
  recoveryExportReady: boolean;
  pendingReason: string | null;
}

const DEFAULT_SCHEDULE_HOURS = 24;
const MIN_SCHEDULE_HOURS = 1;
const MAX_SCHEDULE_HOURS = 168;
const RETENTION_DAYS = 30;
const KEEP_GENERATIONS = 12;
const MAX_ERROR_LENGTH = 500;

let inFlight: Promise<void> | null = null;
let scheduleTimer: NodeJS.Timeout | null = null;
let activeChild: ChildProcess | null = null;
let retryFailures = 0;
let nextRetryAt = 0;

function terminateBackupProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return Promise.resolve();
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => resolve());
    });
  }
  child.kill("SIGTERM");
  const hardKill = setTimeout(() => child.kill("SIGKILL"), 2_000);
  hardKill.unref();
  return new Promise((resolve) => child.once("close", () => {
    clearTimeout(hardKill);
    resolve();
  }));
}

function dateString(value: Date | null | undefined): string | null {
  return value instanceof Date ? value.toISOString() : value ? new Date(value).toISOString() : null;
}

function safeError(error: unknown, libraryPath?: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const withoutPath = libraryPath ? message.replaceAll(libraryPath, "[library]") : message;
  return withoutPath.replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_LENGTH) || "Backup failed.";
}

function getBackupScript(): string {
  if (process.env["WILLARD_BACKUP_SCRIPT"]) return process.env["WILLARD_BACKUP_SCRIPT"];
  const cwdCandidates = [
    path.resolve(process.cwd(), "desktop/database-backup.mjs"),
    path.resolve(process.cwd(), "../../desktop/database-backup.mjs"),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../desktop/database-backup.mjs"),
  ];
  return cwdCandidates.find((candidate) => existsSync(candidate)) ?? cwdCandidates[0];
}

function hasProtectedAutomationCredential(): boolean {
  // The Windows launcher decrypts its DPAPI file into the child process
  // environment only. The server never reads or persists the credential.
  return typeof process.env["WILLARD_BACKUP_PASSPHRASE"] === "string" &&
    process.env["WILLARD_BACKUP_PASSPHRASE"]!.length >= 12;
}

function recoveryExportReady(): boolean {
  return process.env["WILLARD_BACKUP_RECOVERY_EXPORT_READY"] === "1";
}

async function loadSettings() {
  const rows = await db.select().from(appSettingsTable)
    .orderBy(desc(isNotNull(appSettingsTable.passwordHash)), asc(appSettingsTable.id))
    .limit(1);
  return rows[0] ?? null;
}

async function setBackupState(
  id: number,
  state: {
    backupStatus?: BackupStatus;
    backupLastAttemptAt?: Date | null;
    backupLastSuccessAt?: Date | null;
    backupLastVerifiedAt?: Date | null;
    backupLastError?: string | null;
  },
): Promise<void> {
  await db.update(appSettingsTable).set(state).where(eq(appSettingsTable.id, id));
}

export function toBackupStatusResponse(settings: {
  backupEnabled?: boolean | null;
  backupScheduleHours?: number | null;
  backupStatus?: string | null;
  backupLastAttemptAt?: Date | null;
  backupLastSuccessAt?: Date | null;
  backupLastVerifiedAt?: Date | null;
  backupLastError?: string | null;
  nasPath?: string | null;
}): BackupStatusResponse {
  let status = BACKUP_STATUSES.includes(settings.backupStatus as BackupStatus)
    ? settings.backupStatus as BackupStatus
    : "NEVER_CONFIGURED";
  if (!hasProtectedAutomationCredential() || !recoveryExportReady() || !settings.nasPath?.trim()) {
    status = "NEVER_CONFIGURED";
  }
  return {
    status,
    enabled: settings.backupEnabled !== false,
    scheduleHours: Math.min(
      MAX_SCHEDULE_HOURS,
      Math.max(MIN_SCHEDULE_HOURS, settings.backupScheduleHours ?? DEFAULT_SCHEDULE_HOURS),
    ),
    lastAttemptAt: dateString(settings.backupLastAttemptAt),
    lastSuccessAt: dateString(settings.backupLastSuccessAt),
    lastVerifiedAt: dateString(settings.backupLastVerifiedAt),
    lastError: settings.backupLastError ?? null,
    destinationClass: "NAS_LIBRARY",
    destinationLabel: "WillardAI/backups",
    recoveryExportReady: recoveryExportReady(),
    pendingReason: status === "PENDING" ? settings.backupLastError ?? "Waiting for the NAS to reconnect." : null,
  };
}

function runBackupProcess(libraryPath: string): Promise<void> {
  const backupRoot = path.join(libraryPath, "WillardAI", "backups");
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        getBackupScript(),
        "backup",
        "--output-dir",
        backupRoot,
        "--retention-days",
        String(RETENTION_DAYS),
        "--keep",
        String(KEEP_GENERATIONS),
      ],
      {
        cwd: path.dirname(getBackupScript()),
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    activeChild = child;
    const timeout = setTimeout(() => child.kill("SIGTERM"), 30 * 60 * 1000);
    timeout.unref();
    let output = "";
    let errorOutput = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { errorOutput += String(chunk); });
    child.once("error", (error) => reject(error));
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (activeChild === child) activeChild = null;
      if (code === 0) {
        logger.info({ operation: "database_backup", output: output.trim().slice(-300) }, "Verified NAS database backup created");
        resolve();
      } else {
        reject(new Error(errorOutput.trim() || output.trim() || (signal ? `Backup stopped by ${signal}.` : `Backup exited with code ${code}.`)));
      }
    });
  });
}

async function runBackup(reason: string): Promise<void> {
  if (inFlight) return inFlight;
  if (reason === "scheduled backup" && Date.now() < nextRetryAt) return;
  inFlight = (async () => {
    const settings = await loadSettings();
    if (!settings || !settings.backupEnabled) return;
    if (!hasProtectedAutomationCredential() || !recoveryExportReady()) {
      await setBackupState(settings.id, { backupStatus: "NEVER_CONFIGURED", backupLastError: null });
      return;
    }
    if (!settings.nasPath?.trim()) {
      await setBackupState(settings.id, { backupStatus: "NEVER_CONFIGURED", backupLastError: null });
      return;
    }
    const attemptedAt = new Date();
    await setBackupState(settings.id, {
      backupStatus: "PENDING",
      backupLastAttemptAt: attemptedAt,
      backupLastError: null,
    });
    const reach = await checkNasReachableAsync(settings.nasPath);
    if (!reach.online || !reach.writable) {
      await setBackupState(settings.id, {
        backupStatus: "PENDING",
        backupLastError: reach.online ? "The NAS is read-only; backup is waiting for write access." : "The NAS is offline; backup is waiting to retry.",
      });
      logger.warn({ reason, operation: "database_backup", nasOnline: reach.online }, "NAS backup pending");
      retryFailures += 1;
      nextRetryAt = Date.now() + Math.min(60 * 60 * 1000, 60_000 * 2 ** Math.min(retryFailures - 1, 6));
      return;
    }
    try {
      await runBackupProcess(settings.nasPath);
      const verifiedAt = new Date();
      await setBackupState(settings.id, {
        backupStatus: "PROTECTED",
        backupLastSuccessAt: verifiedAt,
        backupLastVerifiedAt: verifiedAt,
        backupLastError: null,
      });
      retryFailures = 0;
      nextRetryAt = 0;
    } catch (error) {
      await setBackupState(settings.id, {
        backupStatus: "FAILED",
        backupLastError: safeError(error, settings.nasPath),
      });
      logger.error({ err: error, reason, operation: "database_backup" }, "NAS database backup failed");
      retryFailures += 1;
      nextRetryAt = Date.now() + Math.min(60 * 60 * 1000, 60_000 * 2 ** Math.min(retryFailures - 1, 6));
    }
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

export function requestLibraryBackup(reason = "library work"): Promise<void> {
  return runBackup(reason);
}

export async function getLibraryBackupStatus(): Promise<BackupStatusResponse> {
  const settings = await loadSettings();
  return settings ? toBackupStatusResponse(settings) : toBackupStatusResponse({});
}

export async function updateLibraryBackupSettings(
  patch: { enabled?: boolean; scheduleHours?: number },
): Promise<BackupStatusResponse> {
  const settings = await loadSettings();
  if (!settings) throw new Error("Settings are not initialized.");
  const update: Record<string, unknown> = {};
  if (typeof patch.enabled === "boolean") update.backupEnabled = patch.enabled;
  if (typeof patch.scheduleHours === "number" && Number.isInteger(patch.scheduleHours)) {
    if (patch.scheduleHours < MIN_SCHEDULE_HOURS || patch.scheduleHours > MAX_SCHEDULE_HOURS) {
      throw new Error(`Backup schedule must be between ${MIN_SCHEDULE_HOURS} and ${MAX_SCHEDULE_HOURS} hours.`);
    }
    update.backupScheduleHours = patch.scheduleHours;
  }
  if (Object.keys(update).length > 0) {
    await db.update(appSettingsTable).set(update).where(eq(appSettingsTable.id, settings.id));
  }
  return getLibraryBackupStatus();
}

export function startLibraryBackupCoordinator(): void {
  if (scheduleTimer) return;
  void requestLibraryBackup("startup backup check")
    .catch((error) => logger.error({ err: error }, "Startup NAS backup check failed"));
  scheduleTimer = setInterval(() => {
    void (async () => {
      const status = await getLibraryBackupStatus();
      if (!status.enabled) return;
      const dueAt = status.lastSuccessAt
        ? new Date(status.lastSuccessAt).getTime() + status.scheduleHours * 60 * 60 * 1000
        : 0;
      if (status.status === "PENDING" || status.status === "FAILED" || Date.now() >= dueAt) {
        await requestLibraryBackup("scheduled backup");
      }
    })().catch((error) => logger.error({ err: error }, "Scheduled NAS backup check failed"));
  }, 60_000);
  scheduleTimer.unref();
}

export async function stopLibraryBackupCoordinator(): Promise<void> {
  if (scheduleTimer) {
    clearInterval(scheduleTimer);
    scheduleTimer = null;
  }
  if (activeChild) await terminateBackupProcessTree(activeChild);
  if (inFlight) {
    await Promise.race([
      inFlight,
      new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 5_000);
        timeout.unref();
      }),
    ]);
  }
}
