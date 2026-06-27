import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { appSettingsTable } from "@workspace/db";

const router: IRouter = Router();

async function getSettings() {
  const rows = await db.select().from(appSettingsTable).limit(1);
  return rows[0];
}

async function immichFetch(settings: any, endpoint: string) {
  const baseUrl = settings?.immichBaseUrl?.replace(/\/$/, "") ?? "";
  const apiKey = settings?.immichApiKey ?? "";
  if (!baseUrl || !apiKey) throw new Error("Immich not configured");
  const r = await fetch(`${baseUrl}/api${endpoint}`, {
    headers: { "x-api-key": apiKey },
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) throw new Error(`Immich returned ${r.status}`);
  return r.json();
}

router.get("/immich/status", async (_req, res) => {
  try {
    const settings = await getSettings();
    if (!settings?.immichBaseUrl || !settings?.immichApiKey) {
      res.json({ connected: false, baseUrl: "", photoCount: 0, videoCount: 0, albumCount: 0, personCount: 0, error: "Not configured" });
      return;
    }
    const stats = await immichFetch(settings, "/server/statistics") as any;
    const albums = await immichFetch(settings, "/albums") as any[];
    const people = await immichFetch(settings, "/people?withHidden=false") as any;
    res.json({
      connected: true,
      baseUrl: settings.immichBaseUrl,
      photoCount: stats.photos ?? 0,
      videoCount: stats.videos ?? 0,
      albumCount: Array.isArray(albums) ? albums.length : 0,
      personCount: people?.people?.length ?? 0,
      error: null,
    });
  } catch (err) {
    res.json({ connected: false, baseUrl: "", photoCount: 0, videoCount: 0, albumCount: 0, personCount: 0, error: err instanceof Error ? err.message : "Failed" });
  }
});

router.get("/immich/recent-photos", async (req, res) => {
  try {
    const limit = parseInt((req.query.limit as string) ?? "20");
    const settings = await getSettings();
    const assets = await immichFetch(settings, `/assets?take=${limit}&order=desc`) as any[];
    const baseUrl = settings?.immichBaseUrl?.replace(/\/$/, "") ?? "";
    const apiKey = settings?.immichApiKey ?? "";
    res.json(assets.map((a: any) => ({
      id: a.id,
      filename: a.originalFileName ?? a.id,
      type: a.type?.toLowerCase() ?? "image",
      thumbUrl: `${baseUrl}/api/assets/${a.id}/thumbnail?apiKey=${apiKey}`,
      createdAt: a.fileCreatedAt ?? a.createdAt ?? new Date().toISOString(),
    })));
  } catch {
    res.json([]);
  }
});

router.get("/immich/albums", async (_req, res) => {
  try {
    const settings = await getSettings();
    const albums = await immichFetch(settings, "/albums") as any[];
    const baseUrl = settings?.immichBaseUrl?.replace(/\/$/, "") ?? "";
    const apiKey = settings?.immichApiKey ?? "";
    res.json(albums.map((a: any) => ({
      id: a.id,
      albumName: a.albumName,
      assetCount: a.assetCount ?? 0,
      thumbUrl: a.albumThumbnailAssetId ? `${baseUrl}/api/assets/${a.albumThumbnailAssetId}/thumbnail?apiKey=${apiKey}` : null,
    })));
  } catch {
    res.json([]);
  }
});

router.get("/immich/people", async (_req, res) => {
  try {
    const settings = await getSettings();
    const data = await immichFetch(settings, "/people?withHidden=false") as any;
    const people = data?.people ?? [];
    const baseUrl = settings?.immichBaseUrl?.replace(/\/$/, "") ?? "";
    const apiKey = settings?.immichApiKey ?? "";
    res.json(people.map((p: any) => ({
      id: p.id,
      name: p.name || "Unknown",
      assetCount: p.assetCount ?? 0,
      thumbUrl: p.thumbnailPath ? `${baseUrl}/api/people/${p.id}/thumbnail?apiKey=${apiKey}` : null,
    })));
  } catch {
    res.json([]);
  }
});

export default router;
