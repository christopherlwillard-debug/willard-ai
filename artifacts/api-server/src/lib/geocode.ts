import { pool } from "@workspace/db";
import { logger } from "./logger.ts";

/**
 * Reverse geocoding for GPS-tagged media.
 *
 * Coordinates are clustered on the same ~11 km grid as auto place collections
 * (1 decimal place, stored as integers lat10 = round(lat * 10)). Each grid cell
 * is resolved to a human place name ("Bern, Switzerland") via the OSM Nominatim
 * API and cached in geo_place_cache. Successful names are retained; negative
 * lookups are retried only after a long cooldown. Lookups are rate limited to
 * respect Nominatim's usage policy (max 1 req/sec).
 */

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse";
const USER_AGENT = "WillardAI-NAS-MediaCenter/1.0 (self-hosted personal media server)";
const MAX_LOOKUPS_PER_RUN = 25;
const DELAY_MS = 1100;
const UNRESOLVED_NAME = "__UNRESOLVED__";
const UNRESOLVED_RETRY_INTERVAL = "30 days";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Return the integer key used for a coordinate's ~11 km place grid cell. */
export function placeGridCoordinate(value: number): number {
  return Math.round(value * 10);
}

/** Resolve one grid cell to "Locality, Country" via Nominatim. Throws on network/HTTP errors. */
export async function reverseGeocodeCell(lat10: number, lon10: number): Promise<string | null> {
  const lat = lat10 / 10;
  const lon = lon10 / 10;
  const url = `${NOMINATIM_URL}?format=jsonv2&lat=${lat}&lon=${lon}&zoom=10&accept-language=en`;
  const resp = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error(`Nominatim responded ${resp.status}`);
  const data: any = await resp.json();
  const a = data?.address ?? {};
  const locality =
    a.city ?? a.town ?? a.village ?? a.hamlet ?? a.municipality ?? a.county ?? a.state_district ?? a.state;
  const name = [locality, a.country].filter(Boolean).join(", ");
  if (name) return name;
  if (typeof data?.display_name === "string" && data.display_name.trim()) {
    return data.display_name.split(",").slice(0, 2).map((s: string) => s.trim()).filter(Boolean).join(", ") || null;
  }
  return null;
}

/** Fetch all cached cell names as a Map keyed by "lat10,lon10". */
export async function getCachedPlaceNames(): Promise<Map<string, string>> {
  const { rows } = await pool.query(
    `SELECT lat10, lon10, name FROM geo_place_cache WHERE name <> $1`,
    [UNRESOLVED_NAME],
  );
  const map = new Map<string, string>();
  for (const r of rows) map.set(`${r.lat10},${r.lon10}`, r.name);
  return map;
}

/**
 * Resolve place names for GPS-tagged files in a library.
 * 1. Finds grid cells not yet in the cache, or whose negative cache entry has
 *    expired, and geocodes up to MAX_LOOKUPS_PER_RUN of them (rate limited).
 * 2. Syncs media_files.place_name from the cache for every GPS-tagged file.
 */
export async function backfillPlaceNames(nasPath: string): Promise<{ resolved: number; updated: number }> {
  const { rows: cells } = await pool.query(
    `SELECT DISTINCT floor(f.gps_latitude::numeric * 10 + 0.5)::int AS lat10,
                     floor(f.gps_longitude::numeric * 10 + 0.5)::int AS lon10
       FROM media_files f
      WHERE f.nas_path = $1
        AND f.gps_latitude IS NOT NULL AND f.gps_longitude IS NOT NULL
        AND (f.last_scan_action IS NULL OR f.last_scan_action <> 'DELETED')
       AND NOT EXISTS (
           SELECT 1 FROM geo_place_cache c
            WHERE c.lat10 = floor(f.gps_latitude::numeric * 10 + 0.5)::int
              AND c.lon10 = floor(f.gps_longitude::numeric * 10 + 0.5)::int
              AND (c.name <> $2 OR c.resolved_at > now() - interval '${UNRESOLVED_RETRY_INTERVAL}')
         )
      LIMIT ${MAX_LOOKUPS_PER_RUN}`,
    [nasPath, UNRESOLVED_NAME],
  );

  let resolved = 0;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    try {
      const name = await reverseGeocodeCell(c.lat10, c.lon10);
      if (name) {
        await pool.query(
          `INSERT INTO geo_place_cache (lat10, lon10, name) VALUES ($1, $2, $3)
           ON CONFLICT (lat10, lon10) DO UPDATE SET name = EXCLUDED.name, resolved_at = now()`,
          [c.lat10, c.lon10, name],
        );
        resolved++;
      } else {
        await pool.query(
          `INSERT INTO geo_place_cache (lat10, lon10, name) VALUES ($1, $2, $3)
           ON CONFLICT (lat10, lon10) DO UPDATE SET name = EXCLUDED.name, resolved_at = now()`,
          [c.lat10, c.lon10, UNRESOLVED_NAME],
        );
      }
    } catch (err) {
      logger.warn({ err, lat10: c.lat10, lon10: c.lon10 }, "Reverse geocode failed — will retry on next run");
      break; // likely offline or rate limited; stop hammering, retry next run
    }
    if (i < cells.length - 1) await sleep(DELAY_MS);
  }

  const { rowCount } = await pool.query(
    `UPDATE media_files f SET place_name = c.name
       FROM geo_place_cache c
      WHERE f.nas_path = $1
        AND f.gps_latitude IS NOT NULL AND f.gps_longitude IS NOT NULL
        AND c.lat10 = floor(f.gps_latitude::numeric * 10 + 0.5)::int
        AND c.lon10 = floor(f.gps_longitude::numeric * 10 + 0.5)::int
       AND c.name <> $2
        AND f.place_name IS DISTINCT FROM c.name`,
    [nasPath, UNRESOLVED_NAME],
  );

  if (resolved > 0 || (rowCount ?? 0) > 0) {
    logger.info({ nasPath, resolved, updated: rowCount ?? 0 }, "Place names backfilled");
  }
  return { resolved, updated: rowCount ?? 0 };
}
