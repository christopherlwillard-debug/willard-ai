import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { indexedFilesTable, appSettingsTable } from "@workspace/db";
import { eq, ilike, gte, lte, and, sql, desc, count } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

const router: IRouter = Router();

/**
 * Search local indexed files AND Immich assets (when configured).
 * Returns a unified result set.
 */
router.get("/files/search", async (req, res) => {
  try {
    const { q, fileType, minSize, maxSize, after, before, source, limit = "50", offset = "0" } = req.query as Record<string, string>;

    const lim = parseInt(limit);
    const off = parseInt(offset);

    // --- Local DB search ---
    const conditions: SQL[] = [];
    if (q) conditions.push(ilike(indexedFilesTable.filename, `%${q}%`));
    if (fileType && fileType !== "all") conditions.push(eq(indexedFilesTable.fileType, fileType));
    if (source && source !== "all" && source !== "immich") conditions.push(eq(indexedFilesTable.source, source));
    if (minSize) conditions.push(gte(indexedFilesTable.sizeBytes, parseInt(minSize)));
    if (maxSize) conditions.push(lte(indexedFilesTable.sizeBytes, parseInt(maxSize)));
    if (after) conditions.push(gte(indexedFilesTable.modifiedAt, new Date(after)));
    if (before) conditions.push(lte(indexedFilesTable.modifiedAt, new Date(before)));

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [{ total: localTotal }] = await db.select({ total: count() }).from(indexedFilesTable).where(where);
    const localFiles = await db.select().from(indexedFilesTable)
      .where(where)
      .orderBy(desc(indexedFilesTable.modifiedAt))
      .limit(lim)
      .offset(off);

    // --- Immich search (when configured and source != "local") ---
    let immichResults: any[] = [];
    let immichTotal = 0;

    const shouldSearchImmich = !source || source === "all" || source === "immich";
    if (shouldSearchImmich && q) {
      try {
        const settingsRows = await db.select().from(appSettingsTable).limit(1);
        const settings = settingsRows[0];
        const baseUrl = settings?.immichBaseUrl?.replace(/\/$/, "");
        const apiKey = settings?.immichApiKey;

        if (baseUrl && apiKey) {
          const searchBody: Record<string, unknown> = {
            query: q,
            size: lim,
            page: Math.floor(off / lim) + 1,
          };
          if (fileType === "image") searchBody.type = "IMAGE";
          if (fileType === "video") searchBody.type = "VIDEO";

          const r = await fetch(`${baseUrl}/api/search/metadata`, {
            method: "POST",
            headers: { "x-api-key": apiKey, "content-type": "application/json" },
            body: JSON.stringify(searchBody),
            signal: AbortSignal.timeout(5000),
          });

          if (r.ok) {
            const data = await r.json() as any;
            const assets: any[] = data?.assets?.items ?? [];
            immichTotal = data?.assets?.total ?? assets.length;
            immichResults = assets.map((a: any) => ({
              id: `immich:${a.id}`,
              path: a.originalPath ?? a.id,
              filename: a.originalFileName ?? a.id,
              extension: (a.originalFileName ?? "").split(".").pop() ?? "",
              fileType: a.type?.toLowerCase() === "video" ? "video" : "image",
              sizeBytes: a.exifInfo?.fileSizeInByte ?? 0,
              modifiedAt: a.fileModifiedAt ?? a.fileCreatedAt ?? null,
              folder: a.originalPath ? a.originalPath.split("/").slice(0, -1).join("/") : "",
              source: "immich",
              contentHash: null,
              indexedAt: new Date().toISOString(),
              thumbUrl: `/api/immich/thumbnail/asset/${a.id}`,
            }));
          }
        }
      } catch {
        // Immich unavailable — fall back to local only
      }
    }

    const allFiles = source === "immich"
      ? immichResults
      : source === "local"
        ? localFiles
        : [...localFiles, ...immichResults];

    const totalCount = source === "immich"
      ? immichTotal
      : source === "local"
        ? localTotal
        : localTotal + immichTotal;

    res.json({
      files: allFiles.slice(0, lim),
      total: totalCount,
      offset: off,
      limit: lim,
      sources: { local: localTotal, immich: immichTotal },
    });
  } catch {
    res.status(500).json({ error: "Search failed" });
  }
});

export default router;
