import { db } from "@workspace/db";
import { collectionsTable, collectionItemsTable, mediaFilesTable } from "@workspace/db";
import { and, eq, sql, inArray, isNull, notInArray } from "drizzle-orm";
import { z } from "zod";
import { logger } from "./logger";
import { backfillPlaceNames, getCachedPlaceNames } from "./geocode";

// ─────────────────────────────────────────────────────────────────────────────
// Smart folder rules — evaluated at query time, never materialized.
// ─────────────────────────────────────────────────────────────────────────────

const isoDate = z.string().refine((s) => !Number.isNaN(new Date(s).getTime()), "Invalid date");

export const smartRuleSchema = z.object({
  mediaTypes: z.array(z.enum(["photo", "video", "audio", "document", "other"])).max(10).optional(),
  extensions: z.array(z.string().min(1).max(20)).max(50).optional(),
  nameContains: z.string().max(200).optional(),
  dateFrom: isoDate.optional(),
  dateTo: isoDate.optional(),
  minSizeBytes: z.number().finite().nonnegative().optional(),
  maxSizeBytes: z.number().finite().nonnegative().optional(),
  minDurationSeconds: z.number().finite().nonnegative().optional(),
  maxDurationSeconds: z.number().finite().nonnegative().optional(),
  favoritesOnly: z.boolean().optional(),
}).strip();

export type SmartRule = z.infer<typeof smartRuleSchema>;

/** Strict validation for incoming API payloads. Returns error message or null. */
export function validateSmartRule(raw: unknown): { rule: SmartRule } | { error: string } {
  const parsed = smartRuleSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { error: `Invalid smart rule: ${first ? `${first.path.join(".")} ${first.message}` : "malformed"}` };
  }
  return { rule: parsed.data };
}

const bestDate = sql`COALESCE(${mediaFilesTable.dateTaken}, ${mediaFilesTable.dateCreated}, ${mediaFilesTable.modifiedAt})`;

export function buildSmartConditions(rule: SmartRule, nasPath: string) {
  const conditions = [eq(mediaFilesTable.nasPath, nasPath)];
  if (rule.mediaTypes && rule.mediaTypes.length > 0) {
    conditions.push(inArray(mediaFilesTable.mediaType, rule.mediaTypes));
  }
  if (rule.extensions && rule.extensions.length > 0) {
    const exts = rule.extensions.map((e) => e.toLowerCase().replace(/^\./, ""));
    conditions.push(sql`LOWER(${mediaFilesTable.extension}) IN (${sql.join(exts.map((e) => sql`${e}`), sql`, `)})`);
  }
  if (rule.nameContains) {
    conditions.push(sql`${mediaFilesTable.name} ILIKE ${"%" + rule.nameContains + "%"}`);
  }
  if (rule.dateFrom) {
    conditions.push(sql`${bestDate} >= ${new Date(rule.dateFrom)}`);
  }
  if (rule.dateTo) {
    conditions.push(sql`${bestDate} <= ${new Date(rule.dateTo)}`);
  }
  if (rule.minSizeBytes != null) {
    conditions.push(sql`${mediaFilesTable.sizeBytes} >= ${rule.minSizeBytes}`);
  }
  if (rule.maxSizeBytes != null) {
    conditions.push(sql`${mediaFilesTable.sizeBytes} <= ${rule.maxSizeBytes}`);
  }
  if (rule.minDurationSeconds != null) {
    conditions.push(sql`${mediaFilesTable.durationSeconds} >= ${rule.minDurationSeconds}`);
  }
  if (rule.maxDurationSeconds != null) {
    conditions.push(sql`${mediaFilesTable.durationSeconds} <= ${rule.maxDurationSeconds}`);
  }
  if (rule.favoritesOnly) {
    conditions.push(eq(mediaFilesTable.favorite, true));
  }
  return and(...conditions)!;
}

/**
 * Lenient parsing for persisted rules: strips unknown/invalid fields so one
 * malformed stored rule can never crash listing endpoints.
 */
export function parseSmartRule(raw: unknown): SmartRule {
  if (raw == null || typeof raw !== "object") return {};
  const parsed = smartRuleSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  // Salvage the valid fields individually.
  const rule: Record<string, unknown> = {};
  for (const [key, fieldSchema] of Object.entries(smartRuleSchema.shape)) {
    const value = (raw as Record<string, unknown>)[key];
    if (value === undefined) continue;
    const r = (fieldSchema as z.ZodTypeAny).safeParse(value);
    if (r.success) rule[key] = r.data;
  }
  return rule as SmartRule;
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-album engine
// ─────────────────────────────────────────────────────────────────────────────

const MIN_EVENT_ITEMS = 3;
const MIN_PLACE_ITEMS = 3;
const MIN_DOC_ITEMS = 1;

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

interface AutoGroup {
  autoKey: string;
  name: string;
  description: string;
  fileIds: number[];
}

function docCategory(name: string, keywords: string | null, title: string | null): string | null {
  const hay = `${name} ${keywords ?? ""} ${title ?? ""}`.toLowerCase();
  if (/receipt|invoice|rechnung|quittung|bill\b|billing/.test(hay)) return "receipts";
  if (/manual|handbook|handbuch|guide|instructions|anleitung/.test(hay)) return "manuals";
  if (/statement|bank|tax|steuer|w-?2|1099/.test(hay)) return "finance";
  return null;
}

async function computeAutoGroups(nasPath: string): Promise<AutoGroup[]> {
  const groups = new Map<string, AutoGroup>();
  const add = (key: string, name: string, description: string, fileId: number) => {
    let g = groups.get(key);
    if (!g) {
      g = { autoKey: key, name, description, fileIds: [] };
      groups.set(key, g);
    }
    g.fileIds.push(fileId);
  };

  // Events: photos/videos grouped by year-month of the best available date.
  const eventRows = await db
    .select({
      id: mediaFilesTable.id,
      d: sql<string | null>`to_char(${bestDate}, 'YYYY-MM')`,
    })
    .from(mediaFilesTable)
    .where(and(
      eq(mediaFilesTable.nasPath, nasPath),
      inArray(mediaFilesTable.mediaType, ["photo", "video"]),
    ));
  for (const row of eventRows) {
    if (!row.d) continue;
    const [y, m] = row.d.split("-");
    const monthName = MONTHS[parseInt(m, 10) - 1] ?? m;
    add(`event:${row.d}`, `${monthName} ${y}`, `Photos & videos from ${monthName} ${y}`, row.id);
  }

  // Places: GPS clustered on a ~11 km grid (1 decimal place).
  const placeRows = await db
    .select({
      id: mediaFilesTable.id,
      lat: mediaFilesTable.gpsLatitude,
      lon: mediaFilesTable.gpsLongitude,
    })
    .from(mediaFilesTable)
    .where(and(
      eq(mediaFilesTable.nasPath, nasPath),
      sql`${mediaFilesTable.gpsLatitude} IS NOT NULL AND ${mediaFilesTable.gpsLongitude} IS NOT NULL`,
    ));
  const cellNames = await getCachedPlaceNames().catch(() => new Map<string, string>());
  for (const row of placeRows) {
    const lat10 = Math.round((row.lat as number) * 10);
    const lon10 = Math.round((row.lon as number) * 10);
    const lat = lat10 / 10;
    const lon = lon10 / 10;
    const ns = lat >= 0 ? "N" : "S";
    const ew = lon >= 0 ? "E" : "W";
    const placeName = cellNames.get(`${lat10},${lon10}`);
    const name = placeName ?? `Around ${Math.abs(lat).toFixed(1)}°${ns}, ${Math.abs(lon).toFixed(1)}°${ew}`;
    const description = placeName ? `Media taken in and around ${placeName}` : "Media taken near this location";
    add(`place:${lat},${lon}`, name, description, row.id);
  }

  // Document categories.
  const docRows = await db
    .select({
      id: mediaFilesTable.id,
      name: mediaFilesTable.name,
      ext: mediaFilesTable.extension,
      kw: mediaFilesTable.pdfKeywords,
      title: mediaFilesTable.pdfTitle,
    })
    .from(mediaFilesTable)
    .where(and(
      eq(mediaFilesTable.nasPath, nasPath),
      eq(mediaFilesTable.mediaType, "document"),
    ));
  for (const row of docRows) {
    const cat = docCategory(row.name, row.kw, row.title);
    if (cat === "receipts") add("doc:receipts", "Receipts & Invoices", "Documents that look like receipts, invoices, or bills", row.id);
    else if (cat === "manuals") add("doc:manuals", "Manuals & Guides", "Instruction manuals, handbooks, and guides", row.id);
    else if (cat === "finance") add("doc:finance", "Financial Documents", "Statements, tax, and banking documents", row.id);
    else {
      const ext = (row.ext || "").toLowerCase();
      if (ext === "pdf") add("doc:pdf", "PDFs", "All PDF documents", row.id);
      else if (["xls", "xlsx", "csv", "ods", "numbers"].includes(ext)) add("doc:spreadsheets", "Spreadsheets", "Spreadsheets and tabular data", row.id);
      else if (["ppt", "pptx", "key", "odp"].includes(ext)) add("doc:presentations", "Presentations", "Slide decks and presentations", row.id);
      else add("doc:other", "Other Documents", "Text files, notes, and other documents", row.id);
    }
  }

  // Apply minimum sizes.
  return [...groups.values()].filter((g) => {
    if (g.autoKey.startsWith("event:")) return g.fileIds.length >= MIN_EVENT_ITEMS;
    if (g.autoKey.startsWith("place:")) return g.fileIds.length >= MIN_PLACE_ITEMS;
    return g.fileIds.length >= MIN_DOC_ITEMS;
  });
}

let rebuildRunning = false;

/**
 * Rebuild all auto collections for the given library. Idempotent:
 * - Existing auto albums (matched by autoKey) keep their user-given name.
 * - Auto albums the user removed (removedAt set) are never resurrected.
 * - Auto albums whose group no longer exists are deleted.
 * - Membership is replaced wholesale to reflect current library state.
 */
export async function rebuildAutoCollections(nasPath: string): Promise<{ collections: number; items: number }> {
  if (rebuildRunning) return { collections: 0, items: 0 };
  rebuildRunning = true;
  try {
    // Resolve human place names for GPS cells first so place collections get real names.
    await backfillPlaceNames(nasPath).catch((err) => {
      logger.warn({ err, nasPath }, "Place name backfill failed — using coordinate names");
    });
    const groups = await computeAutoGroups(nasPath);
    const keys = groups.map((g) => g.autoKey);

    // Remove stale auto albums (group disappeared), except tombstoned ones.
    if (keys.length > 0) {
      await db.delete(collectionsTable).where(and(
        eq(collectionsTable.nasPath, nasPath),
        eq(collectionsTable.kind, "auto"),
        isNull(collectionsTable.removedAt),
        notInArray(collectionsTable.autoKey, keys),
      ));
    } else {
      await db.delete(collectionsTable).where(and(
        eq(collectionsTable.nasPath, nasPath),
        eq(collectionsTable.kind, "auto"),
        isNull(collectionsTable.removedAt),
      ));
    }

    let totalItems = 0;
    for (const g of groups) {
      const existing = await db
        .select()
        .from(collectionsTable)
        .where(and(eq(collectionsTable.nasPath, nasPath), eq(collectionsTable.autoKey, g.autoKey)))
        .limit(1);

      if (existing.length > 0 && existing[0].removedAt) continue; // user deleted — stay deleted

      let collectionId: number;
      if (existing.length > 0) {
        collectionId = existing[0].id;
        // Upgrade auto-generated coordinate names ("Around 46.9°N, 7.4°E") to real
        // place names once geocoded — but never touch a user-customized name.
        const upgradeName = existing[0].name.startsWith("Around ") && existing[0].name !== g.name;
        await db.update(collectionsTable)
          .set(upgradeName
            ? { name: g.name, description: g.description, updatedAt: new Date() }
            : { updatedAt: new Date() })
          .where(eq(collectionsTable.id, collectionId));
      } else {
        const [created] = await db.insert(collectionsTable).values({
          nasPath,
          kind: "auto",
          name: g.name,
          description: g.description,
          autoKey: g.autoKey,
        }).returning();
        collectionId = created.id;
      }

      // Replace membership.
      await db.delete(collectionItemsTable).where(eq(collectionItemsTable.collectionId, collectionId));
      for (let i = 0; i < g.fileIds.length; i += 500) {
        const batch = g.fileIds.slice(i, i + 500).map((fid) => ({ collectionId, mediaFileId: fid }));
        await db.insert(collectionItemsTable).values(batch).onConflictDoNothing();
      }
      totalItems += g.fileIds.length;

      // Set cover to newest item if missing or no longer a member.
      const cover = existing[0]?.coverFileId ?? null;
      const coverStillValid = cover != null && g.fileIds.includes(cover);
      if (!coverStillValid) {
        await db.update(collectionsTable)
          .set({ coverFileId: g.fileIds[g.fileIds.length - 1] })
          .where(eq(collectionsTable.id, collectionId));
      }
    }

    logger.info({ nasPath, collections: groups.length, items: totalItems }, "Auto collections rebuilt");
    return { collections: groups.length, items: totalItems };
  } catch (err) {
    logger.warn({ err, nasPath }, "Auto collection rebuild failed");
    throw err;
  } finally {
    rebuildRunning = false;
  }
}
