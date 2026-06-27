import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { appSettingsTable } from "@workspace/db";
import type { Request, Response } from "express";

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

/** Build a server-side proxy URL so the API key never reaches the browser. */
function thumbProxyUrl(assetId: string, type: "asset" | "person" = "asset"): string {
  return `/api/immich/thumbnail/${type}/${assetId}`;
}

router.get("/immich/status", async (_req: Request, res: Response) => {
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
      baseUrl: "",
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

router.get("/immich/recent-photos", async (req: Request, res: Response) => {
  try {
    const limit = parseInt((req.query.limit as string) ?? "20");
    const settings = await getSettings();
    const assets = await immichFetch(settings, `/assets?take=${limit}&order=desc`) as any[];
    res.json(assets.map((a: any) => ({
      id: a.id,
      filename: a.originalFileName ?? a.id,
      type: a.type?.toLowerCase() ?? "image",
      thumbUrl: thumbProxyUrl(a.id, "asset"),
      createdAt: a.fileCreatedAt ?? a.createdAt ?? new Date().toISOString(),
    })));
  } catch {
    res.json([]);
  }
});

router.get("/immich/albums", async (_req: Request, res: Response) => {
  try {
    const settings = await getSettings();
    const albums = await immichFetch(settings, "/albums") as any[];
    res.json(albums.map((a: any) => ({
      id: a.id,
      albumName: a.albumName,
      assetCount: a.assetCount ?? 0,
      thumbUrl: a.albumThumbnailAssetId ? thumbProxyUrl(a.albumThumbnailAssetId, "asset") : null,
    })));
  } catch {
    res.json([]);
  }
});

router.get("/immich/people", async (_req: Request, res: Response) => {
  try {
    const settings = await getSettings();
    const data = await immichFetch(settings, "/people?withHidden=false") as any;
    const people = data?.people ?? [];
    res.json(people.map((p: any) => ({
      id: p.id,
      name: p.name || "Unknown",
      assetCount: p.assetCount ?? 0,
      thumbUrl: p.thumbnailPath ? thumbProxyUrl(p.id, "person") : null,
    })));
  } catch {
    res.json([]);
  }
});

/** Server-side thumbnail proxy — API key never leaves the server. */
router.get("/immich/thumbnail/:type/:id", async (req: Request, res: Response) => {
  try {
    const { type, id } = req.params;
    const settings = await getSettings();
    const baseUrl = settings?.immichBaseUrl?.replace(/\/$/, "") ?? "";
    const apiKey = settings?.immichApiKey ?? "";
    if (!baseUrl || !apiKey) {
      res.status(503).send("Immich not configured");
      return;
    }

    let endpoint: string;
    if (type === "person") {
      endpoint = `${baseUrl}/api/people/${id}/thumbnail`;
    } else {
      endpoint = `${baseUrl}/api/assets/${id}/thumbnail`;
    }

    const upstream = await fetch(endpoint, {
      headers: { "x-api-key": apiKey },
      signal: AbortSignal.timeout(10000),
    });

    if (!upstream.ok) {
      res.status(upstream.status).send("Upstream error");
      return;
    }

    const contentType = upstream.headers.get("content-type") ?? "image/jpeg";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=3600");

    const buffer = await upstream.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch {
    res.status(502).send("Failed to proxy thumbnail");
  }
});

export default router;
