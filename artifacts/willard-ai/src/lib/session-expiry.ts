function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

export function isProtectedApiRequest(input: RequestInfo | URL, apiBaseUrl: string): boolean {
  const request = new URL(requestUrl(input), apiBaseUrl);
  const apiBase = new URL(apiBaseUrl);

  return (
    request.origin === apiBase.origin &&
    request.pathname.startsWith(apiBase.pathname) &&
    !request.pathname.startsWith(`${apiBase.pathname}auth/`)
  );
}

export function createUnauthorizedAwareFetch(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  onUnauthorized: () => void,
): typeof fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    if (response.status === 401 && isProtectedApiRequest(input, apiBaseUrl)) {
      onUnauthorized();
    }
    return response;
  };
}