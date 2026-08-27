# Storage-policy conformance

`storage-conformance.json` is the release-gated source of truth. Every media
pipeline must document its destination, retention, capacity guard, NAS-offline
behavior, resume behavior, duplicate protection, reclaim boundary, and
executable evidence. The validator rejects incomplete rows before a Windows
payload is staged.

| Pipeline | Destination | Retention / reclaim boundary | NAS offline and resume |
| --- | --- | --- | --- |
| Scan and index | Configured NAS library | Originals stay on NAS; directory cache is bounded and rebuildable | Pause with durable cursor; resume only after the same library returns |
| Search and index enrichment | NAS source plus API database | Source/thumbnail bytes stay on NAS; rows are rebuildable | Pause source work; retry by media identity |
| Archive peek and extract | NAS `WillardAI/temp` | Job-owned scratch only; indexes/reports remain | Stop without OS temp fallback; restart from unchanged archive |
| Cleanup and restore | NAS `WillardAI/.Trash` | Recycle data is recoverable and never automatic reclaim | Pause with originals untouched; manifest-backed retry |
| Optimization and conversion | NAS conversions, backups, and recycle | Protected backups retained; unapplied working output may be recovered | Pause with original and backup intact |
| AI enrichment | NAS source/derivatives plus API database | AI rows rebuildable; cloud use requires privacy consent | Pause NAS reads/writes; no cloud call from a local fallback |
| Face recognition | NAS face cache plus bounded local model cache | Crops stay NAS-scoped; verified model can be redownloaded | Pause crops; retry under a per-library lock |
| Imports | NAS destinations and NAS scratch | Originals and operation history remain NAS-backed | Fail closed or pause; verified hashes prevent duplicate copies |
| Exports | Explicit browser/mobile download target | Device-local and ephemeral; not NAS persistence | Existing download is client-local; new server export requires NAS |
| Thumbnail reconciliation | NAS thumbnail cache | Bounded, rebuildable, atomic cache entries | Cancel/pause without local fallback; partial files excluded |
| NAS-loss recovery | API control state plus NAS recovery artifacts | Jobs/manifests/backups survive restart; no permanent archive reclaim | Persist paused state and re-probe on reconnect |
| Operational logs and reports | NAS history plus bounded launcher logs | Redacted, bounded retention; never media fallback | Keep diagnostics private and report the failure |

## Environment coverage

| Environment | Local bytes allowed | Required validation |
| --- | --- | --- |
| Linux/Replit | Control-plane state and explicitly bounded local model cache | Policy tests; NAS paths are correctly treated as unreachable on Linux |
| Windows developer mode | Launcher state, bounded update staging, package/build caches | Launcher/update smoke tests and low-headroom checks |
| Windows packaged mode | Installed runtime and bounded update staging | Clean install, update, rollback, restart, sleep/reconnect, mapped drive, UNC, locked file, and low-headroom lifecycle smoke |
| Web/PWA | App shell cache, small UI state, explicit downloads | Service worker bypasses private API/media responses |
| Mobile | Session/chat identifiers and platform-managed device cache | Streaming preview test; no full-library download/cache |

Windows and NAS scenarios that require physical devices or shares remain
environment validation evidence; their required smoke scripts are listed in
the matrix rather than being simulated as a local filesystem test.