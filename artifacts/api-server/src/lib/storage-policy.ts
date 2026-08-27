import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const STORAGE_POLICY_VERSION = "2026-08-27";

export type StorageClass =
  | "NAS_REQUIRED"
  | "BOUNDED_LOCAL"
  | "BROWSER_DEVICE_LOCAL"
  | "CONTROL_PLANE_LOCAL";

export type StorageDestination =
  | "NAS_LIBRARY"
  | "API_CONTROL_PLANE"
  | "DESKTOP_CONTROL_PLANE"
  | "BROWSER_DEVICE"
  | "MOBILE_DEVICE";

export type StorageDurability =
  | "NAS_BACKED"
  | "RECOVERABLE_FROM_NAS_BACKUP"
  | "REBUILDABLE"
  | "EPHEMERAL";

export type StorageAccounting =
  | "DATABASE"
  | "NAS_FILESYSTEM"
  | "LOCAL_FILESYSTEM"
  | "BROWSER_DEVICE"
  | "NOT_SERVER_VISIBLE";

export interface StorageInventoryEntry {
  id: string;
  category: string;
  storageClass: StorageClass;
  destination: StorageDestination;
  durability: StorageDurability;
  accounting: StorageAccounting;
  pathPattern: string;
  maxBytes: number | null;
  protected: boolean;
  reclaimable: boolean;
  notes: string;
}

/**
 * The maintained storage contract. Keep this list complete when adding a new
 * byte-producing feature. The API exposes the same safe, path-pattern-only
 * representation; it never sends the configured library path to clients.
 */
export const STORAGE_INVENTORY: readonly StorageInventoryEntry[] = [
  {
    id: "original-media",
    category: "Original media",
    storageClass: "NAS_REQUIRED",
    destination: "NAS_LIBRARY",
    durability: "NAS_BACKED",
    accounting: "DATABASE",
    pathPattern: "<LIBRARY>/{configured media destinations}",
    maxBytes: null,
    protected: true,
    reclaimable: false,
    notes: "Canonical originals are never a local fallback and are never reclaimed by capacity housekeeping.",
  },
  {
    id: "recycle-contents",
    category: "Recycle contents",
    storageClass: "NAS_REQUIRED",
    destination: "NAS_LIBRARY",
    durability: "NAS_BACKED",
    accounting: "NAS_FILESYSTEM",
    pathPattern: "<LIBRARY>/WillardAI/.Trash/**",
    maxBytes: null,
    protected: true,
    reclaimable: false,
    notes: "User-controlled recovery data; expiry is an explicit cleanup action, not capacity reclamation.",
  },
  {
    id: "verified-database-backups",
    category: "Verified database backups",
    storageClass: "NAS_REQUIRED",
    destination: "NAS_LIBRARY",
    durability: "NAS_BACKED",
    accounting: "NAS_FILESYSTEM",
    pathPattern: "<LIBRARY>/WillardAI/backups/**",
    maxBytes: null,
    protected: true,
    reclaimable: false,
    notes: "Encrypted and verified backups are protected from automatic space reclamation.",
  },
  {
    id: "catalog-and-manual-metadata",
    category: "Catalog and manual metadata",
    storageClass: "CONTROL_PLANE_LOCAL",
    destination: "API_CONTROL_PLANE",
    durability: "RECOVERABLE_FROM_NAS_BACKUP",
    accounting: "DATABASE",
    pathPattern: "PostgreSQL; encrypted backup in <LIBRARY>/WillardAI/backups/**",
    maxBytes: null,
    protected: true,
    reclaimable: false,
    notes: "Manual metadata, albums, tags, catalog identity, and history are irreplaceable even when stored in PostgreSQL.",
  },
  {
    id: "jobs-and-recovery-state",
    category: "Jobs and recovery state",
    storageClass: "CONTROL_PLANE_LOCAL",
    destination: "API_CONTROL_PLANE",
    durability: "RECOVERABLE_FROM_NAS_BACKUP",
    accounting: "DATABASE",
    pathPattern: "PostgreSQL; encrypted backup in <LIBRARY>/WillardAI/backups/**",
    maxBytes: null,
    protected: true,
    reclaimable: false,
    notes: "Job records explain interrupted work and must not disappear as a side effect of storage pressure.",
  },
  {
    id: "thumbnail-derivatives",
    category: "Thumbnail derivatives",
    storageClass: "NAS_REQUIRED",
    destination: "NAS_LIBRARY",
    durability: "REBUILDABLE",
    accounting: "NAS_FILESYSTEM",
    pathPattern: "<LIBRARY>/WillardAI/cache/thumbnails/**",
    maxBytes: null,
    protected: false,
    reclaimable: true,
    notes: "Rebuildable does not mean local: derivative bytes remain beside the library and are never written to OS temp.",
  },
  {
    id: "preview-derivatives",
    category: "Preview derivatives",
    storageClass: "NAS_REQUIRED",
    destination: "NAS_LIBRARY",
    durability: "REBUILDABLE",
    accounting: "NAS_FILESYSTEM",
    pathPattern: "<LIBRARY>/WillardAI/cache/previews/**",
    maxBytes: 2 * 1024 * 1024 * 1024,
    protected: false,
    reclaimable: true,
    notes: "Preview bytes are rebuildable, bounded, and remain on the NAS beside their source library.",
  },
  {
    id: "document-derivatives",
    category: "PDF and document previews",
    storageClass: "NAS_REQUIRED",
    destination: "NAS_LIBRARY",
    durability: "REBUILDABLE",
    accounting: "NAS_FILESYSTEM",
    pathPattern: "<LIBRARY>/WillardAI/cache/documents/**",
    maxBytes: 512 * 1024 * 1024,
    protected: false,
    reclaimable: true,
    notes: "Rendered document pages and extracted preview artifacts never use an unbounded local cache.",
  },
  {
    id: "transcode-derivatives",
    category: "Transcode derivatives",
    storageClass: "NAS_REQUIRED",
    destination: "NAS_LIBRARY",
    durability: "REBUILDABLE",
    accounting: "NAS_FILESYSTEM",
    pathPattern: "<LIBRARY>/WillardAI/cache/transcodes/**",
    maxBytes: 5 * 1024 * 1024 * 1024,
    protected: false,
    reclaimable: true,
    notes: "Reusable transcodes are bounded NAS derivatives; in-progress output belongs in NAS temp.",
  },
  {
    id: "archive-derived-media",
    category: "Archive-derived media",
    storageClass: "NAS_REQUIRED",
    destination: "NAS_LIBRARY",
    durability: "REBUILDABLE",
    accounting: "NAS_FILESYSTEM",
    pathPattern: "<LIBRARY>/WillardAI/temp/archive-derived/**",
    maxBytes: 5 * 1024 * 1024 * 1024,
    protected: false,
    reclaimable: true,
    notes: "Archive extraction output is bounded scratch and is removed or retained only by its owning operation.",
  },
  {
    id: "face-derivatives",
    category: "Face derivatives",
    storageClass: "NAS_REQUIRED",
    destination: "NAS_LIBRARY",
    durability: "REBUILDABLE",
    accounting: "NAS_FILESYSTEM",
    pathPattern: "<LIBRARY>/WillardAI/cache/faces/**",
    maxBytes: null,
    protected: false,
    reclaimable: true,
    notes: "Crops are rebuildable but can contain sensitive biometric context, so they remain NAS-scoped.",
  },
  {
    id: "ai-derived-metadata",
    category: "AI-derived metadata and embeddings",
    storageClass: "CONTROL_PLANE_LOCAL",
    destination: "API_CONTROL_PLANE",
    durability: "REBUILDABLE",
    accounting: "DATABASE",
    pathPattern: "PostgreSQL; source media and thumbnail bytes remain on NAS",
    maxBytes: null,
    protected: false,
    reclaimable: true,
    notes: "AI rows are rebuildable; cloud sends still require the shared privacy policy.",
  },
  {
    id: "conversion-staging",
    category: "Conversion staging and backups",
    storageClass: "NAS_REQUIRED",
    destination: "NAS_LIBRARY",
    durability: "NAS_BACKED",
    accounting: "NAS_FILESYSTEM",
    pathPattern: "<LIBRARY>/WillardAI/ConversionBackups/**",
    maxBytes: null,
    protected: true,
    reclaimable: false,
    notes: "Conversion outputs and original-preservation backups must not silently use %TEMP% or /tmp.",
  },
  {
    id: "conversion-working-staging",
    category: "Conversion working staging",
    storageClass: "NAS_REQUIRED",
    destination: "NAS_LIBRARY",
    durability: "REBUILDABLE",
    accounting: "NAS_FILESYSTEM",
    pathPattern: "<LIBRARY>/WillardAI/conversions/**",
    maxBytes: 5 * 1024 * 1024 * 1024,
    protected: false,
    reclaimable: true,
    notes: "Verified conversion outputs are temporary until the user applies them and are cleaned by job recovery.",
  },
  {
    id: "temporary-work",
    category: "Archive, import, and media-processing temporary work",
    storageClass: "NAS_REQUIRED",
    destination: "NAS_LIBRARY",
    durability: "EPHEMERAL",
    accounting: "NAS_FILESYSTEM",
    pathPattern: "<LIBRARY>/WillardAI/temp/**",
    maxBytes: null,
    protected: false,
    reclaimable: true,
    notes: "Scratch bytes are disposable only after the owning job completes or is explicitly cancelled.",
  },
  {
    id: "archive-index-and-reports",
    category: "Archive indexes and operation reports",
    storageClass: "NAS_REQUIRED",
    destination: "NAS_LIBRARY",
    durability: "NAS_BACKED",
    accounting: "NAS_FILESYSTEM",
    pathPattern: "<LIBRARY>/WillardAI/{archive-index,reports}/**",
    maxBytes: null,
    protected: true,
    reclaimable: false,
    notes: "Archive history and redacted reports provide recovery context and have bounded retention.",
  },
  {
    id: "logs-and-scan-history",
    category: "Logs and scan history",
    storageClass: "NAS_REQUIRED",
    destination: "NAS_LIBRARY",
    durability: "NAS_BACKED",
    accounting: "NAS_FILESYSTEM",
    pathPattern: "<LIBRARY>/WillardAI/{logs,scan-history}/**",
    maxBytes: null,
    protected: false,
    reclaimable: true,
    notes: "Private NAS logs are bounded by retention; stdout is observability fallback, not durable storage.",
  },
  {
    id: "face-model-cache",
    category: "Face model cache",
    storageClass: "BOUNDED_LOCAL",
    destination: "API_CONTROL_PLANE",
    durability: "REBUILDABLE",
    accounting: "LOCAL_FILESYSTEM",
    pathPattern: "~/.cache/willard-face-models/**",
    maxBytes: 1 * 1024 * 1024 * 1024,
    protected: false,
    reclaimable: true,
    notes: "Verified model artifacts are a bounded local cache and can be downloaded again.",
  },
  {
    id: "branding-assets",
    category: "Branding assets",
    storageClass: "CONTROL_PLANE_LOCAL",
    destination: "API_CONTROL_PLANE",
    durability: "RECOVERABLE_FROM_NAS_BACKUP",
    accounting: "LOCAL_FILESYSTEM",
    pathPattern: "<API_DATA>/branding/**",
    maxBytes: 2 * 1024 * 1024,
    protected: true,
    reclaimable: false,
    notes: "Small user-provided branding bytes are control-plane state and are size-limited at upload.",
  },
  {
    id: "desktop-runtime-state",
    category: "Desktop launcher state and logs",
    storageClass: "CONTROL_PLANE_LOCAL",
    destination: "DESKTOP_CONTROL_PLANE",
    durability: "RECOVERABLE_FROM_NAS_BACKUP",
    accounting: "LOCAL_FILESYSTEM",
    pathPattern: "%LOCALAPPDATA%/Willard Media Center/{logs,updates,*.json,.env}",
    maxBytes: 512 * 1024 * 1024,
    protected: true,
    reclaimable: false,
    notes: "Launcher state controls startup and update recovery; it is not a library-media fallback.",
  },
  {
    id: "installer-and-update-staging",
    category: "Installer and update staging",
    storageClass: "BOUNDED_LOCAL",
    destination: "DESKTOP_CONTROL_PLANE",
    durability: "EPHEMERAL",
    accounting: "LOCAL_FILESYSTEM",
    pathPattern: "%LOCALAPPDATA%/Willard Media Center/updates/**",
    maxBytes: 2 * 1024 * 1024 * 1024,
    protected: false,
    reclaimable: true,
    notes: "Installer payloads are bounded and may be cleaned only through update recovery rules.",
  },
  {
    id: "browser-state",
    category: "Browser state and app shell cache",
    storageClass: "BROWSER_DEVICE_LOCAL",
    destination: "BROWSER_DEVICE",
    durability: "REBUILDABLE",
    accounting: "BROWSER_DEVICE",
    pathPattern: "Browser Cache Storage and localStorage",
    maxBytes: 100 * 1024 * 1024,
    protected: false,
    reclaimable: true,
    notes: "Only app shell and small UI state are client-local; authenticated media/API bytes are not cached there.",
  },
  {
    id: "browser-exports-and-downloads",
    category: "Browser exports and downloads",
    storageClass: "BROWSER_DEVICE_LOCAL",
    destination: "BROWSER_DEVICE",
    durability: "EPHEMERAL",
    accounting: "BROWSER_DEVICE",
    pathPattern: "Browser download target and in-memory Blob URLs",
    maxBytes: null,
    protected: false,
    reclaimable: false,
    notes: "User-initiated exports are device-local; the server never treats uncontrolled downloads as durable library storage.",
  },
  {
    id: "mobile-session-and-chat-state",
    category: "Mobile session and chat state",
    storageClass: "BROWSER_DEVICE_LOCAL",
    destination: "MOBILE_DEVICE",
    durability: "REBUILDABLE",
    accounting: "BROWSER_DEVICE",
    pathPattern: "Mobile AsyncStorage session and active conversation keys",
    maxBytes: 1 * 1024 * 1024,
    protected: false,
    reclaimable: true,
    notes: "Mobile keeps identifiers only; media bytes and catalog state remain server-side.",
  },
] as const;

export type StoragePolicyState = "READY" | "READ_ONLY" | "PAUSED" | "UNCONFIGURED";

export interface StoragePolicyReachability {
  online: boolean;
  writable: boolean;
  message: string;
  configured?: boolean;
}

export function getStoragePolicyState(
  reach: StoragePolicyReachability,
): StoragePolicyState {
  if (reach.configured === false) return "UNCONFIGURED";
  if (!reach.online) return "PAUSED";
  if (!reach.writable) return "READ_ONLY";
  return "READY";
}

export class StoragePolicyError extends Error {
  readonly code = "NAS_STORAGE_REQUIRED";
  readonly storageClass: StorageClass = "NAS_REQUIRED";

  constructor(message: string) {
    super(message);
    this.name = "StoragePolicyError";
  }
}

export interface DirectoryUsage {
  bytes: number;
  files: number;
  complete: boolean;
}

const DIRECTORY_WALK_LIMIT = 50_000;

export async function measureDirectoryBytes(
  directory: string,
  limit = DIRECTORY_WALK_LIMIT,
): Promise<DirectoryUsage> {
  let bytes = 0;
  let files = 0;
  let visited = 0;
  const pending = [directory];

  while (pending.length > 0 && visited < limit) {
    const current = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (visited >= limit) break;
      visited++;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile()) {
        try {
          bytes += (await fs.promises.stat(entryPath)).size;
          files++;
        } catch {
          // A disappearing file is reported by the incomplete flag rather than
          // turning a diagnostic read into a destructive or blocking operation.
        }
      }
    }
  }

  return { bytes, files, complete: pending.length === 0 && visited < limit };
}

export interface StorageUsage {
  id: string;
  category: string;
  storageClass: StorageClass;
  destination: StorageDestination;
  durability: StorageDurability;
  protected: boolean;
  reclaimable: boolean;
  currentBytes: number | null;
  projectedBytes: number | null;
  maxBytes: number | null;
  accounting: StorageAccounting;
  measurement: "exact" | "database" | "unavailable" | "not_server_visible";
}

export interface StorageCapacity {
  totalBytes: number | null;
  freeBytes: number | null;
  usedBytes: number | null;
  known: boolean;
}

export interface StoragePolicyStatus {
  policyVersion: string;
  state: StoragePolicyState;
  stateMessage: string;
  nasConfigured: boolean;
  libraryReachable: boolean;
  libraryWritable: boolean;
  capacity: StorageCapacity;
  currentBytes: number;
  projectedBytes: number;
  usage: StorageUsage[];
}

function safeNumber(value: number | bigint): number {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : Number.MAX_SAFE_INTEGER;
}

async function readCapacity(nasPath: string): Promise<StorageCapacity> {
  try {
    const stats = await fs.promises.statfs(nasPath);
    const totalBytes = safeNumber(stats.blocks) * safeNumber(stats.bsize);
    const freeBytes = safeNumber(stats.bavail) * safeNumber(stats.bsize);
    return {
      totalBytes,
      freeBytes,
      usedBytes: Math.max(0, totalBytes - freeBytes),
      known: Number.isFinite(totalBytes) && Number.isFinite(freeBytes),
    };
  } catch {
    return { totalBytes: null, freeBytes: null, usedBytes: null, known: false };
  }
}

function inventoryUsage(
  entry: StorageInventoryEntry,
  currentBytes: number | null,
  measurement: StorageUsage["measurement"],
): StorageUsage {
  const projectedBytes = currentBytes === null
    ? entry.maxBytes
    : entry.maxBytes === null
      ? currentBytes
      : Math.max(currentBytes, entry.maxBytes);
  return {
    id: entry.id,
    category: entry.category,
    storageClass: entry.storageClass,
    destination: entry.destination,
    durability: entry.durability,
    protected: entry.protected,
    reclaimable: entry.reclaimable,
    currentBytes,
    projectedBytes,
    maxBytes: entry.maxBytes,
    accounting: entry.accounting,
    measurement,
  };
}

function safeStateMessage(state: StoragePolicyState): string {
  if (state === "UNCONFIGURED") return "No library location configured.";
  if (state === "PAUSED") return "NAS storage is unavailable; NAS-required work is paused.";
  if (state === "READ_ONLY") return "NAS storage is reachable but read-only; NAS-required work is paused.";
  return "NAS storage is available for NAS-required work.";
}

/**
 * Collect a bounded, non-destructive policy report. `originalBytes` is passed
 * by the route from the catalog because walking a large library just for
 * diagnostics would be both slow and needlessly sensitive.
 */
export async function getStoragePolicyStatus(
  nasPath: string | null | undefined,
  reach: StoragePolicyReachability,
  originalBytes: number | null = null,
): Promise<StoragePolicyStatus> {
  const nasConfigured = Boolean(nasPath?.trim());
  const state = getStoragePolicyState({ ...reach, configured: nasConfigured });
  const usage = new Map<string, number | null>();
  const measurement = new Map<string, StorageUsage["measurement"]>();

  for (const entry of STORAGE_INVENTORY) {
    usage.set(entry.id, null);
    measurement.set(entry.id, entry.accounting === "NOT_SERVER_VISIBLE" || entry.accounting === "BROWSER_DEVICE"
      ? "not_server_visible"
      : "unavailable");
  }
  usage.set("original-media", originalBytes);
  measurement.set("original-media", originalBytes === null ? "unavailable" : "database");

  let capacity: StorageCapacity = { totalBytes: null, freeBytes: null, usedBytes: null, known: false };
  if (nasPath && reach.online) {
    const root = path.join(nasPath, "WillardAI");
    capacity = await readCapacity(nasPath);
    const paths: Array<[string, string]> = [
      ["recycle-contents", path.join(root, ".Trash")],
      ["verified-database-backups", path.join(root, "backups")],
      ["thumbnail-derivatives", path.join(root, "cache", "thumbnails")],
      ["preview-derivatives", path.join(root, "cache", "previews")],
      ["document-derivatives", path.join(root, "cache", "documents")],
      ["transcode-derivatives", path.join(root, "cache", "transcodes")],
      ["archive-derived-media", path.join(root, "temp", "archive-derived")],
      ["face-derivatives", path.join(root, "cache", "faces")],
      ["conversion-staging", path.join(root, "ConversionBackups")],
      ["conversion-working-staging", path.join(root, "conversions")],
      ["temporary-work", path.join(root, "temp")],
      ["archive-index-and-reports", path.join(root, "archive-index")],
      ["logs-and-scan-history", path.join(root, "logs")],
    ];
    for (const [id, directory] of paths) {
      const result = await measureDirectoryBytes(directory);
      usage.set(id, result.bytes);
      measurement.set(id, result.complete ? "exact" : "unavailable");
    }
  }

  const reportUsage = STORAGE_INVENTORY.map((entry) =>
    inventoryUsage(entry, usage.get(entry.id) ?? null, measurement.get(entry.id) ?? "unavailable"),
  );
  const currentBytes = reportUsage.reduce((total, item) => total + (item.currentBytes ?? 0), 0);
  const projectedBytes = reportUsage.reduce((total, item) => total + (item.projectedBytes ?? 0), 0);

  return {
    policyVersion: STORAGE_POLICY_VERSION,
    state,
    stateMessage: safeStateMessage(state),
    nasConfigured,
    libraryReachable: reach.online,
    libraryWritable: reach.writable,
    capacity,
    currentBytes,
    projectedBytes,
    usage: reportUsage,
  };
}

export function getLocalPolicyRoots(): { faceModels: string; apiData: string } {
  return {
    faceModels: path.join(os.homedir(), ".cache", "willard-face-models"),
    apiData: path.join(process.cwd(), "data"),
  };
}