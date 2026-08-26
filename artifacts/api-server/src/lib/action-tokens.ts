import { randomBytes } from "node:crypto";

const ACTION_TOKEN_TTL_MS = 5 * 60 * 1000;
const MAX_TOKENS_PER_SESSION = 32;

type SessionLike = {
  actionTokens?: Record<string, {
    action: string;
    resource: string;
    expiresAt: number;
  }>;
  save?: (callback: (error?: unknown) => void) => void;
};

type TokenRequest = {
  session?: SessionLike;
  sessionID?: string;
};

type IssuedToken = {
  sessionId: string;
  action: string;
  resource: string;
  expiresAt: number;
};

// The session record is the durable source of truth. These process-local maps
// close the race between two requests that load the same session before the
// session store has persisted the first request's mutation.
const issuedTokens = new Map<string, IssuedToken>();
const consumedTokens = new Map<string, number>();

function prune(now: number): void {
  for (const [token, entry] of issuedTokens) {
    if (entry.expiresAt <= now) issuedTokens.delete(token);
  }
  for (const [token, expiresAt] of consumedTokens) {
    if (expiresAt <= now) consumedTokens.delete(token);
  }
}

function saveSession(req: TokenRequest): Promise<void> {
  if (!req.session?.save) return Promise.resolve();
  return new Promise((resolve, reject) => {
    req.session!.save!((error) => error ? reject(error) : resolve());
  });
}

/**
 * Issue a short-lived token for one exact destructive/action-stream operation.
 * The token is intentionally opaque and is never written to logs.
 */
export async function issueActionToken(
  req: TokenRequest,
  action: string,
  resource: string,
): Promise<string> {
  const now = Date.now();
  prune(now);

  const session = req.session;
  if (!session) throw new Error("Authenticated session is required");

  const token = randomBytes(32).toString("base64url");
  const expiresAt = now + ACTION_TOKEN_TTL_MS;
  const actionTokens = session.actionTokens ?? {};

  for (const [existingToken, entry] of Object.entries(actionTokens)) {
    if (entry.expiresAt <= now) delete actionTokens[existingToken];
  }
  const existing = Object.keys(actionTokens);
  for (const oldToken of existing.slice(0, Math.max(0, existing.length - MAX_TOKENS_PER_SESSION + 1))) {
    delete actionTokens[oldToken];
  }

  actionTokens[token] = { action, resource, expiresAt };
  session.actionTokens = actionTokens;
  issuedTokens.set(token, {
    sessionId: req.sessionID ?? "",
    action,
    resource,
    expiresAt,
  });
  try {
    await saveSession(req);
  } catch (error) {
    delete actionTokens[token];
    issuedTokens.delete(token);
    throw error;
  }
  return token;
}

/**
 * Consume exactly one token. It is removed before the caller starts touching
 * the filesystem, so a replay cannot start a second operation.
 */
export async function consumeActionToken(
  req: TokenRequest,
  token: unknown,
  action: string,
  resource: string,
): Promise<boolean> {
  const now = Date.now();
  prune(now);
  if (typeof token !== "string" || token.length < 40) return false;
  if (consumedTokens.has(token)) return false;

  const sessionEntry = req.session?.actionTokens?.[token];
  const processEntry = issuedTokens.get(token);
  const entry = sessionEntry ?? processEntry;
  if (!entry || entry.expiresAt <= now) return false;
  if (entry.action !== action || entry.resource !== resource) return false;
  if (processEntry?.sessionId && req.sessionID && processEntry.sessionId !== req.sessionID) return false;

  if (req.session?.actionTokens) {
    delete req.session.actionTokens[token];
  }
  issuedTokens.delete(token);
  consumedTokens.set(token, now + ACTION_TOKEN_TTL_MS);
  await saveSession(req);
  return true;
}
