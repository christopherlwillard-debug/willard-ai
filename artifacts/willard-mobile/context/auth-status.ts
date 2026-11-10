export type MobileAuthStatus =
  | { kind: "authenticated" }
  | { kind: "unauthenticated" }
  | { kind: "setup_required" }
  | { kind: "error"; message: string };

export type AuthStatusRequestInit = Pick<RequestInit, "credentials" | "headers">;
export type AuthStatusFetch = (input: string, init?: AuthStatusRequestInit) => Promise<Response>;

export async function fetchMobileAuthStatus(
  fetcher: AuthStatusFetch,
  url: string,
  cookie: string | null,
): Promise<MobileAuthStatus> {
  try {
    const response = await fetcher(url, {
      credentials: "include",
      headers: cookie ? { Cookie: cookie } : undefined,
    });
    const body = await response.json().catch(() => ({})) as {
      setup?: unknown;
      authenticated?: unknown;
      error?: unknown;
    };
    if (!response.ok) {
      return {
        kind: "error",
        message: typeof body.error === "string"
          ? body.error
          : "Willard could not verify your session. Check the connection and retry.",
      };
    }
    if (typeof body.setup !== "boolean" || typeof body.authenticated !== "boolean") {
      return { kind: "error", message: "Willard returned an invalid session status. Retry the check." };
    }
    if (body.setup) return { kind: "setup_required" };
    return body.authenticated ? { kind: "authenticated" } : { kind: "unauthenticated" };
  } catch {
    return {
      kind: "error",
      message: "Willard could not verify your session. Check the connection and retry.",
    };
  }
}
