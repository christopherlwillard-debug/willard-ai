---
name: Auth architecture
description: How Willard AI authentication works — session cookies, bcryptjs, connect-pg-simple, single-user password model
---

# Auth architecture

## The rule
All `/api/*` routes except `/api/auth/*` and `/api/healthz` require a valid session. The auth guard is in `artifacts/api-server/src/app.ts` before the router mount.

**Why:** Single-owner NAS dashboard — one password protects everything. No user accounts, no roles.

## How to apply
- New API routes are automatically protected — no per-route auth needed.
- Auth-exempt routes: add to the `publicPaths` array in `app.ts`.
- Session data shape stored in `sess` JSON: `{ authenticated, deviceName, ip, createdAt, lastSeenAt }`.

## Key decisions
- `bcryptjs` (pure JS, no native deps) with 12 rounds — sufficient for single-user desktop app.
- `connect-pg-simple` with `createTableIfMissing: true` — session table (`session`) is created lazily on first login write.
- Session cookie name: `willard.sid`, rolling 7-day expiry, httpOnly, sameSite=lax.
- Recovery key format: 4 groups of 4 chars (e.g. `AB2F-91KQ-H82L-7C3P`), stored as bcrypt hash.
- Rate limiting: 5 attempts / 15 min per IP on `/api/auth/login` (express-rate-limit). Recovery endpoint NOT yet rate-limited (tech debt — see follow-up task).
- `SESSION_SECRET` is read from env var; a warning is logged if missing; do not hardcode for prod.

## Frontend
- `AuthProvider` in `src/context/auth-context.tsx` calls `GET /api/auth/status` on mount.
- `AuthGate` in `App.tsx`: spinner → first-run setup → login page → protected app.
- Logout button in sidebar clears QueryClient and invalidates auth status.
- Security section in `settings.tsx`: change password + active sessions list.
