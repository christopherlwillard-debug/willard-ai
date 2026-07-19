---
name: wouter router conventions
description: Project uses wouter (not react-router-dom) — replacement patterns for common hooks
---

This project uses `wouter` for routing. `react-router-dom` is NOT installed and importing from it causes a Vite overlay error that blocks the entire app.

**Why:** The project was bootstrapped with wouter. Any page accidentally importing from react-router-dom compiles but fails at Vite transform time (pre-transform error), showing a full-screen overlay that blocks all routes, not just the affected page (because imports are eager in App.tsx).

**How to apply:**

| react-router-dom | wouter equivalent |
|---|---|
| `useNavigate()` → `navigate(path)` | `const [, setLocation] = useLocation(); setLocation(path)` |
| `useSearchParams()` → `[params, setParams]` | `const search = useSearch(); const params = new URLSearchParams(search);` for reads; `setLocation('/path')` to clear params |
| `useParams()` | `const params = useParams()` (wouter exports this too) |
| `<Link to="...">` | `<Link href="...">` from wouter |

**Clearing query params in wouter:**
```ts
// Instead of setSearchParams({})
setLocation('/current-page'); // navigate to clean URL without query string
```
