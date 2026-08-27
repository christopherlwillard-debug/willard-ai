import * as fs from "fs";
import * as path from "path";
import crypto from "node:crypto";

export const LOCAL_CONTROL_PLANE_FLOOR_BYTES = 4 * 1024 ** 3;
export const NAS_SAFETY_MARGIN_BYTES = 4 * 1024 ** 3;
export const DEFAULT_LOCAL_OPERATION_BYTES = 64 * 1024 ** 2;

export type CapacityTarget = "local" | "nas";
export type CapacityFailureCode =
  | "LOCAL_CAPACITY_UNKNOWN"
  | "LOCAL_SPACE_LOW"
  | "NAS_CAPACITY_UNKNOWN"
  | "NAS_SPACE_LOW";

export interface CapacitySnapshot {
  target: CapacityTarget;
  path: string;
  totalBytes: number | null;
  freeBytes: number | null;
  known: boolean;
  checkedAt: string;
  error?: string;
}

export interface CapacityRequirement {
  nasPath: string;
  operation: string;
  localBytes?: number;
  nasBytes?: number;
}

export interface CapacityAdmission {
  allowed: boolean;
  code: "OK" | CapacityFailureCode;
  message: string;
  operation: string;
  required: {
    localBytes: number;
    nasBytes: number;
  };
  floors: {
    localBytes: number;
    nasBytes: number;
  };
  local: CapacitySnapshot;
  nas: CapacitySnapshot;
  reserved: {
    localBytes: number;
    nasBytes: number;
  };
}

export interface CapacityReservation {
  id: string;
  operation: string;
  createdAt: string;
  expiresAt: string;
  localBytes: number;
  nasBytes: number;
  nasPath: string;
}

export class CapacityAdmissionError extends Error {
  readonly code: CapacityFailureCode;
  readonly admission: CapacityAdmission;

  constructor(admission: CapacityAdmission) {
    super(admission.message);
    this.name = "CapacityAdmissionError";
    this.code = admission.code as CapacityFailureCode;
    this.admission = admission;
  }
}

type CapacityProbe = (target: CapacityTarget, targetPath: string) => Promise<CapacitySnapshot>;
let probe: CapacityProbe = defaultProbe;

const RESERVATION_TTL_MS = 30 * 60_000;
const reservations = new Map<string, CapacityReservation>();
let reservationTail = Promise.resolve();

function configuredBytes(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? Math.ceil(value) : fallback;
}

export function getCapacityPolicy(): { localFloorBytes: number; nasSafetyMarginBytes: number } {
  return {
    localFloorBytes: configuredBytes("WILLARD_LOCAL_CAPACITY_FLOOR_BYTES", LOCAL_CONTROL_PLANE_FLOOR_BYTES),
    nasSafetyMarginBytes: configuredBytes("WILLARD_NAS_SAFETY_MARGIN_BYTES", NAS_SAFETY_MARGIN_BYTES),
  };
}

function getLocalCapacityPath(): string {
  if (process.env.WILLARD_LOCAL_DATA_ROOT?.trim()) return process.env.WILLARD_LOCAL_DATA_ROOT.trim();
  if (process.env.LOCALAPPDATA?.trim()) return path.join(process.env.LOCALAPPDATA.trim(), "Willard Media Center");
  return process.cwd();
}

function normalizeBytes(value: number | undefined): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? Math.ceil(value!) : 0;
}

function freeBytesFromStats(stats: fs.StatsFs): { totalBytes: number; freeBytes: number } {
  const totalBytes = Number(stats.blocks) * Number(stats.bsize);
  const freeBytes = Number(stats.bavail) * Number(stats.bsize);
  return { totalBytes, freeBytes };
}

async function defaultProbe(target: CapacityTarget, targetPath: string): Promise<CapacitySnapshot> {
  try {
    const stats = await fs.promises.statfs(targetPath);
    const { totalBytes, freeBytes } = freeBytesFromStats(stats);
    const known = Number.isFinite(totalBytes) && Number.isFinite(freeBytes) && totalBytes >= 0 && freeBytes >= 0;
    return {
      target,
      path: targetPath,
      totalBytes: known ? totalBytes : null,
      freeBytes: known ? freeBytes : null,
      known,
      checkedAt: new Date().toISOString(),
      ...(known ? {} : { error: "Filesystem reported invalid capacity values" }),
    };
  } catch (error) {
    return {
      target,
      path: targetPath,
      totalBytes: null,
      freeBytes: null,
      known: false,
      checkedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : "Capacity probe failed",
    };
  }
}

function pruneExpiredReservations(now = Date.now()): void {
  for (const [id, reservation] of reservations) {
    if (Date.parse(reservation.expiresAt) <= now) reservations.delete(id);
  }
}

export function releaseStaleCapacityReservations(now = Date.now()): number {
  const before = reservations.size;
  pruneExpiredReservations(now);
  return before - reservations.size;
}

function reservedFor(nasPath: string): { localBytes: number; nasBytes: number } {
  releaseStaleCapacityReservations();
  let localBytes = 0;
  let nasBytes = 0;
  for (const reservation of reservations.values()) {
    if (reservation.nasPath !== nasPath) continue;
    localBytes += reservation.localBytes;
    nasBytes += reservation.nasBytes;
  }
  return { localBytes, nasBytes };
}

function failure(
  code: CapacityFailureCode,
  operation: string,
  local: CapacitySnapshot,
  nas: CapacitySnapshot,
  required: { localBytes: number; nasBytes: number },
  floors: { localBytes: number; nasBytes: number },
  reserved: { localBytes: number; nasBytes: number },
): CapacityAdmission {
  const targetLabel = code.startsWith("LOCAL") ? "laptop" : "NAS";
  const action = code.endsWith("UNKNOWN")
    ? `free space on the ${targetLabel} could not be measured`
    : `${targetLabel} free space is below the safe floor`;
  return {
    allowed: false,
    code,
    message: `${operation} is blocked: ${action}. Keep the ${targetLabel} available and retry; no local fallback will be used.`,
    operation,
    required,
    floors,
    local,
    nas,
    reserved,
  };
}

export async function evaluateCapacity(requirement: CapacityRequirement): Promise<CapacityAdmission> {
  const operation = requirement.operation.trim() || "Media operation";
  const localBytes = normalizeBytes(requirement.localBytes) + DEFAULT_LOCAL_OPERATION_BYTES;
  const nasBytes = normalizeBytes(requirement.nasBytes);
  const localPath = getLocalCapacityPath();
  // Keep the configured path intact. A Windows drive/UNC path must not be
  // normalized by Linux path.resolve into a local checkout directory.
  const nasPath = requirement.nasPath.trim();
  const [local, nas] = await Promise.all([
    probe("local", localPath),
    probe("nas", nasPath),
  ]);
  const reserved = reservedFor(nasPath);
  const policy = getCapacityPolicy();
  const floors = {
    localBytes: policy.localFloorBytes,
    nasBytes: policy.nasSafetyMarginBytes,
  };
  const required = { localBytes, nasBytes };

  if (!local.known) return failure("LOCAL_CAPACITY_UNKNOWN", operation, local, nas, required, floors, reserved);
  if ((local.freeBytes ?? 0) - reserved.localBytes < floors.localBytes + localBytes) {
    return failure("LOCAL_SPACE_LOW", operation, local, nas, required, floors, reserved);
  }
  if (!nas.known) return failure("NAS_CAPACITY_UNKNOWN", operation, local, nas, required, floors, reserved);
  if ((nas.freeBytes ?? 0) - reserved.nasBytes < floors.nasBytes + nasBytes) {
    return failure("NAS_SPACE_LOW", operation, local, nas, required, floors, reserved);
  }

  return {
    allowed: true,
    code: "OK",
    message: `${operation} admitted: laptop and NAS headroom are above their safety floors.`,
    operation,
    required,
    floors,
    local,
    nas,
    reserved,
  };
}

export async function reserveCapacity(
  requirement: CapacityRequirement,
): Promise<CapacityReservation> {
  // Serialize probe-and-commit so two large writers cannot both observe the
  // same free bytes and overbook the NAS.
  let releaseGate!: () => void;
  const previous = reservationTail;
  reservationTail = new Promise<void>((resolve) => { releaseGate = resolve; });
  await previous;
  try {
    // Always probe again here. Callers commonly evaluate before asking the user
    // for confirmation; the destination may disappear during that interval.
    const admission = await evaluateCapacity(requirement);
    if (!admission.allowed) throw new CapacityAdmissionError(admission);
    const now = Date.now();
    const reservation: CapacityReservation = {
      id: crypto.randomUUID(),
      operation: admission.operation,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + RESERVATION_TTL_MS).toISOString(),
      localBytes: admission.required.localBytes,
      nasBytes: admission.required.nasBytes,
      nasPath: requirement.nasPath.trim(),
    };
    reservations.set(reservation.id, reservation);
    return reservation;
  } finally {
    releaseGate();
  }
}

export function releaseCapacity(reservationId: string): boolean {
  return reservations.delete(reservationId);
}

export async function withCapacityReservation<T>(
  requirement: CapacityRequirement,
  work: (reservation: CapacityReservation, admission: CapacityAdmission) => Promise<T>,
): Promise<T> {
  const admission = await evaluateCapacity(requirement);
  if (!admission.allowed) throw new CapacityAdmissionError(admission);
  const reservation = await reserveCapacity(requirement);
  try {
    return await work(reservation, admission);
  } finally {
    releaseCapacity(reservation.id);
  }
}

export async function getCapacityStatus(nasPath: string | null | undefined): Promise<{
  local: CapacitySnapshot;
  nas: CapacitySnapshot | null;
  reservations: CapacityReservation[];
  floors: { localBytes: number; nasBytes: number };
}> {
  const local = await probe("local", getLocalCapacityPath());
  const normalizedNasPath = nasPath?.trim() || null;
  const nas = normalizedNasPath ? await probe("nas", normalizedNasPath) : null;
  releaseStaleCapacityReservations();
  const active = normalizedNasPath
    ? [...reservations.values()].filter((reservation) => reservation.nasPath === normalizedNasPath)
    : [];
  return {
    local,
    nas,
    reservations: active,
    floors: {
      localBytes: getCapacityPolicy().localFloorBytes,
      nasBytes: getCapacityPolicy().nasSafetyMarginBytes,
    },
  };
}

export function releaseCapacityReservation(reservationId: string): boolean {
  return releaseCapacity(reservationId);
}

/** Test-only probe injection; returns a restore function. */
export function setCapacityProbeForTests(nextProbe: CapacityProbe): () => void {
  const previous = probe;
  probe = nextProbe;
  return () => { probe = previous; };
}