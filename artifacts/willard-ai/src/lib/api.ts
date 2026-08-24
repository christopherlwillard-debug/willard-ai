const basePath = (import.meta.env.BASE_URL || "/").replace(/\/+$/, "");

export function apiUrl(path: string): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${basePath}/api${suffix}`;
}

export function assetUrl(path: string): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${basePath}${suffix}`;
}

export function eventUrl(path: string): string {
  return apiUrl(path);
}

export async function apiFetch<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), {
    credentials: "include",
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}