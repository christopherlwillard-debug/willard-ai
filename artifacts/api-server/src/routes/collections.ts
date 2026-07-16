import { Router, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { collectionsTable, collectionItemsTable, mediaFilesTable, appSettingsTable } from "@workspace/db";
import { and, eq, sql, count, desc, isNull, inArray } from "drizzle-orm";
import { buildSmartConditions, parseSmartRule, validateSmartRule, rebuildAutoCollections, type SmartRule } from "../lib/collections-engine";

const router = Router();

async function getNasPath(): Promise<string | null> {
  const [row] = await db.select({ nasPath: appSettingsTable.nasPath }).from(appSettingsTable).limit(1);
  return row?.nasPath ?? null;
}

async function loadCollection(id: number, nasPath: string) {
  const [row] = await db
    .select()
    .from(collectionsTable)
    .where(and(eq(collectionsTable.id, id), eq(collectionsTable.nasPath, nasPath)))
    .limit(1);
  return row ?? null;
}

async function collectionCount(c: { id: number; kind: string; ruleJson: unknown }, nasPath: string): Promise<number> {
  if (c.kind === "smart") {
    const [row] = await db
      .select({ total: count() })
      .from(mediaFilesTable)
      .where(buildSmartConditions(parseSmartRule(c.ruleJson), nasPath));
    return Number(row?.total ?? 0);
  }
  const [row] = await db
    .select({ total: count() })
    .from(collectionItemsTable)
    .where(eq(collectionItemsTable.collectionId, c.id));
  return Number(row?.total ?? 0);
}

async function smartCoverFileId(rule: SmartRule, nasPath: string): Promise<number | null> {
  const [row] = await db
    .select({ id: mediaFilesTable.id })
    .from(mediaFilesTable)
    .where(buildSmartConditions(rule, nasPath))
    .orderBy(desc(mediaFilesTable.indexedAt))
    .limit(1);
  return row?.id ?? null;
}

// ── GET /api/collections ──────────────────────────────────────────────────────

router.get("/collections", async (_req: Request, res: Response) => {
  const nasPath = await getNasPath();
  if (!nasPath) {
    res.json({ collections: [], favoritesCount: 0 });
    return;
  }

  const rows = await db
    .select()
    .from(collectionsTable)
    .where(and(eq(collectionsTable.nasPath, nasPath), isNull(collectionsTable.removedAt)))
    .orderBy(desc(collectionsTable.updatedAt));

  const collections = [];
  for (const c of rows) {
    const itemCount = await collectionCount(c, nasPath);
    let coverFileId = c.coverFileId;
    if (c.kind === "smart") {
      coverFileId = await smartCoverFileId(parseSmartRule(c.ruleJson), nasPath);
    }
    collections.push({
      id: c.id,
      kind: c.kind,
      name: c.name,
      description: c.description,
      autoKey: c.autoKey,
      ruleJson: c.ruleJson,
      coverFileId,
      itemCount,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    });
  }

  const [favRow] = await db
    .select({ total: count() })
    .from(mediaFilesTable)
    .where(and(eq(mediaFilesTable.nasPath, nasPath), eq(mediaFilesTable.favorite, true)));

  res.json({ collections, favoritesCount: Number(favRow?.total ?? 0) });
});

// ── POST /api/collections — create smart or manual ──────────────────────────

router.post("/collections", async (req: Request, res: Response) => {
  const nasPath = await getNasPath();
  if (!nasPath) {
    res.status(400).json({ error: "No library configured" });
    return;
  }
  const { name, kind, description, ruleJson } = req.body ?? {};
  if (!name || typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "Name is required" });
    return;
  }
  if (kind !== "smart" && kind !== "manual") {
    res.status(400).json({ error: "kind must be 'smart' or 'manual'" });
    return;
  }
  let validatedRule: SmartRule | null = null;
  if (kind === "smart") {
    if (ruleJson == null || typeof ruleJson !== "object") {
      res.status(400).json({ error: "Smart folders require ruleJson" });
      return;
    }
    const v = validateSmartRule(ruleJson);
    if ("error" in v) {
      res.status(400).json({ error: v.error });
      return;
    }
    validatedRule = v.rule;
  }

  const [created] = await db.insert(collectionsTable).values({
    nasPath,
    kind,
    name: name.trim(),
    description: description ?? null,
    ruleJson: validatedRule,
  }).returning();

  res.status(201).json({ collection: created });
});

// ── PATCH /api/collections/:id — rename / edit rule ─────────────────────────

router.patch("/collections/:id", async (req: Request, res: Response) => {
  const nasPath = await getNasPath();
  const id = parseInt(req.params["id"] as string, 10);
  if (!nasPath || !Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  const existing = await loadCollection(id, nasPath);
  if (!existing || existing.removedAt) {
    res.status(404).json({ error: "Collection not found" });
    return;
  }

  const { name, description, ruleJson } = req.body ?? {};
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (name !== undefined) {
    if (typeof name !== "string" || !name.trim()) {
      res.status(400).json({ error: "Name cannot be empty" });
      return;
    }
    updates["name"] = name.trim();
  }
  if (description !== undefined) updates["description"] = description;
  if (ruleJson !== undefined) {
    if (existing.kind !== "smart") {
      res.status(400).json({ error: "Only smart folders have rules" });
      return;
    }
    const v = validateSmartRule(ruleJson);
    if ("error" in v) {
      res.status(400).json({ error: v.error });
      return;
    }
    updates["ruleJson"] = v.rule;
  }

  const [updated] = await db.update(collectionsTable).set(updates).where(eq(collectionsTable.id, id)).returning();
  res.json({ collection: updated });
});

// ── DELETE /api/collections/:id ──────────────────────────────────────────────

router.delete("/collections/:id", async (req: Request, res: Response) => {
  const nasPath = await getNasPath();
  const id = parseInt(req.params["id"] as string, 10);
  if (!nasPath || !Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  const existing = await loadCollection(id, nasPath);
  if (!existing || existing.removedAt) {
    res.status(404).json({ error: "Collection not found" });
    return;
  }

  if (existing.kind === "auto") {
    // Tombstone so the rebuild never resurrects it.
    await db.update(collectionsTable)
      .set({ removedAt: new Date(), updatedAt: new Date() })
      .where(eq(collectionsTable.id, id));
    await db.delete(collectionItemsTable).where(eq(collectionItemsTable.collectionId, id));
  } else {
    await db.delete(collectionsTable).where(eq(collectionsTable.id, id));
  }
  res.json({ ok: true });
});

// ── GET /api/collections/:id/items — paged media listing ────────────────────

router.get("/collections/:id/items", async (req: Request, res: Response) => {
  const nasPath = await getNasPath();
  const id = parseInt(req.params["id"] as string, 10);
  if (!nasPath || !Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  const c = await loadCollection(id, nasPath);
  if (!c || c.removedAt) {
    res.status(404).json({ error: "Collection not found" });
    return;
  }

  const page = Math.max(1, parseInt(req.query["page"] as string) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query["limit"] as string) || 60));
  const offset = (page - 1) * limit;

  if (c.kind === "smart") {
    const where = buildSmartConditions(parseSmartRule(c.ruleJson), nasPath);
    const [totalRow] = await db.select({ total: count() }).from(mediaFilesTable).where(where);
    const files = await db
      .select()
      .from(mediaFilesTable)
      .where(where)
      .orderBy(desc(mediaFilesTable.indexedAt))
      .limit(limit)
      .offset(offset);
    res.json({ collection: c, files, total: Number(totalRow?.total ?? 0), page, limit });
    return;
  }

  const [totalRow] = await db
    .select({ total: count() })
    .from(collectionItemsTable)
    .where(eq(collectionItemsTable.collectionId, id));
  const files = await db
    .select({ file: mediaFilesTable })
    .from(collectionItemsTable)
    .innerJoin(mediaFilesTable, eq(collectionItemsTable.mediaFileId, mediaFilesTable.id))
    .where(eq(collectionItemsTable.collectionId, id))
    .orderBy(sql`COALESCE(${mediaFilesTable.dateTaken}, ${mediaFilesTable.dateCreated}, ${mediaFilesTable.modifiedAt}) DESC NULLS LAST`)
    .limit(limit)
    .offset(offset);

  res.json({ collection: c, files: files.map((r) => r.file), total: Number(totalRow?.total ?? 0), page, limit });
});

// ── POST /api/collections/:id/merge — merge source albums into target ───────

router.post("/collections/:id/merge", async (req: Request, res: Response) => {
  const nasPath = await getNasPath();
  const id = parseInt(req.params["id"] as string, 10);
  const sourceIds: number[] = Array.isArray(req.body?.sourceIds)
    ? req.body.sourceIds.map((n: unknown) => parseInt(String(n), 10)).filter((n: number) => Number.isFinite(n) && n !== id)
    : [];
  if (!nasPath || !Number.isFinite(id) || sourceIds.length === 0) {
    res.status(400).json({ error: "Provide target id and sourceIds" });
    return;
  }

  const target = await loadCollection(id, nasPath);
  if (!target || target.removedAt || target.kind === "smart") {
    res.status(400).json({ error: "Target must be an existing album (not a smart folder)" });
    return;
  }

  const sources = await db
    .select()
    .from(collectionsTable)
    .where(and(
      eq(collectionsTable.nasPath, nasPath),
      inArray(collectionsTable.id, sourceIds),
      isNull(collectionsTable.removedAt),
    ));
  const mergeable = sources.filter((s) => s.kind !== "smart");
  if (mergeable.length === 0) {
    res.status(400).json({ error: "No mergeable source albums found" });
    return;
  }

  await db.transaction(async (tx) => {
    for (const s of mergeable) {
      await tx.execute(sql`
        INSERT INTO collection_items (collection_id, media_file_id)
        SELECT ${id}, media_file_id FROM collection_items WHERE collection_id = ${s.id}
        ON CONFLICT DO NOTHING
      `);
      if (s.kind === "auto") {
        await tx.update(collectionsTable)
          .set({ removedAt: new Date(), updatedAt: new Date() })
          .where(eq(collectionsTable.id, s.id));
        await tx.delete(collectionItemsTable).where(eq(collectionItemsTable.collectionId, s.id));
      } else {
        await tx.delete(collectionsTable).where(eq(collectionsTable.id, s.id));
      }
    }

    // Merged album becomes user-managed: detach from the auto engine so the
    // next rebuild doesn't overwrite the combined membership.
    await tx.update(collectionsTable)
      .set({ kind: "manual", autoKey: null, updatedAt: new Date() })
      .where(eq(collectionsTable.id, id));
  });

  const merged = await loadCollection(id, nasPath);
  res.json({ collection: merged, mergedCount: mergeable.length });
});

// ── POST /api/collections/rebuild — regenerate auto albums now ──────────────

router.post("/collections/rebuild", async (_req: Request, res: Response) => {
  const nasPath = await getNasPath();
  if (!nasPath) {
    res.status(400).json({ error: "No library configured" });
    return;
  }
  const result = await rebuildAutoCollections(nasPath);
  res.json(result);
});

export default router;
