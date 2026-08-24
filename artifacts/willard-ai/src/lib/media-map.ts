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

export function parseMediaMapFilters(search: string): MediaMapFilters {
  const params = new URLSearchParams(search);
  return {
    dateFrom: params.get("dateFrom") ?? "",
    dateTo: params.get("dateTo") ?? "",
    mediaType: params.get("mediaType") || "all",
  };
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