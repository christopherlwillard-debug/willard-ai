export interface MediaMapItem {
  id: number;
  name: string;
  mediaType: string;
  dateTaken: string | null;
  latitude: number;
  longitude: number;
  placeName: string | null;
}

interface MediaMapResponse {
  items: MediaMapItem[];
}

export interface MediaMapFilters {
  dateFrom: string;
  dateTo: string;
  mediaType: string;
}

export interface MediaMapViewport {
  centerLat: number;
  centerLon: number;
  zoom: number;
}

export function parseMediaMapFilters(search: string): MediaMapFilters {
  const params = new URLSearchParams(search);
  return {
    dateFrom: params.get("dateFrom") ?? "",
    dateTo: params.get("dateTo") ?? "",
    mediaType: params.get("mediaType") || "all",
  };
}

export function parseMediaMapViewport(search: string): MediaMapViewport | null {
  const params = new URLSearchParams(search);
  const centerLat = Number(params.get("centerLat"));
  const centerLon = Number(params.get("centerLon"));
  const zoom = Number(params.get("zoom"));
  if (
    !Number.isFinite(centerLat) ||
    !Number.isFinite(centerLon) ||
    !Number.isInteger(zoom) ||
    centerLat < -90 ||
    centerLat > 90 ||
    centerLon < -180 ||
    centerLon > 180 ||
    zoom < 1 ||
    zoom > 10
  ) {
    return null;
  }
  return { centerLat, centerLon, zoom };
}

const API = `${import.meta.env.BASE_URL}api`;

export async function fetchMediaMap(signal?: AbortSignal): Promise<MediaMapResponse> {
  const response = await fetch(`${API}/media/map`, {
    credentials: "include",
    signal,
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `Map data unavailable (${response.status})`);
  }

  return response.json() as Promise<MediaMapResponse>;
}