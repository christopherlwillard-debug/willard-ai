# Willard AI storage policy

**Policy version:** `2026-08-27`

The storage inventory in `artifacts/api-server/src/lib/storage-policy.ts` is the
machine-readable source of truth. This document explains the safety rules and
the user-visible destinations without including a configured library path.
`library-durability-manifest.json` is the recovery contract for laptop-loss
scenarios. It classifies permanent, recoverable, and rebuildable library
knowledge and names the clean-machine restore evidence.

## Classes and durability

| Class | Meaning | Allowed destination |
| --- | --- | --- |
| `NAS_REQUIRED` | Bytes must be created under the configured library root. If the NAS is offline or read-only, the owning operation pauses or fails explicitly. | `<LIBRARY>/...` |
| `BOUNDED_LOCAL` | Rebuildable local cache or bounded update staging with an explicit byte budget. | API or desktop control-plane folders |
| `BROWSER_DEVICE_LOCAL` | User-agent state, app-shell cache, or an explicit user download/export. | Browser or mobile device |
| `CONTROL_PLANE_LOCAL` | Small launcher/API control state. It must be recoverable from NAS-backed backups when it represents library knowledge. | API or desktop control-plane folders |

`NAS_BACKED` means the bytes are on the library location. `REBUILDABLE` means
the bytes can be regenerated, but does not permit moving them to an
uncontrolled local temp folder. `RECOVERABLE_FROM_NAS_BACKUP` applies to
control-plane data whose verified encrypted backup is stored under the NAS
backup area. `EPHEMERAL` applies only to work that is safe to discard after
the owning operation ends.

## Inventory

| Category | Class | Durable destination / accounting | Reclaim rule |
| --- | --- | --- | --- |
| Original media | NAS-required | Library root / catalog size | Never automatically reclaim |
| Recycle contents | NAS-required | `WillardAI/.Trash/` / filesystem | Only explicit user recovery cleanup |
| Verified database backups | NAS-required | `WillardAI/backups/` / filesystem | Never automatically reclaim |
| Catalog and manual metadata | Control-plane-local | PostgreSQL + NAS-backed encrypted backup | Never automatically reclaim |
| Jobs and recovery state | Control-plane-local | PostgreSQL + NAS-backed encrypted backup | Never automatically reclaim |
| Thumbnail derivatives | NAS-required | `WillardAI/cache/thumbnails/` / filesystem | Rebuildable; bounded to 1 GiB and oldest valid files are reclaimed |
| Preview derivatives | NAS-required | `WillardAI/cache/previews/` / filesystem | Rebuildable; bounded cache |
| PDF and document previews | NAS-required | `WillardAI/cache/documents/` / filesystem | Rebuildable; bounded cache |
| Transcode derivatives | NAS-required | `WillardAI/cache/transcodes/` / filesystem | Rebuildable; bounded cache |
| Face derivatives | NAS-required | `WillardAI/cache/faces/` / filesystem | Rebuildable, but remain NAS-scoped |
| AI-derived metadata and embeddings | Control-plane-local | PostgreSQL | Rebuildable; no media-byte fallback |
| Conversion staging and backups | NAS-required | `WillardAI/ConversionBackups/` / filesystem | Never as a capacity shortcut |
| Conversion working staging | NAS-required | `WillardAI/conversions/` / filesystem | Rebuildable; cleaned by job recovery and bounded in policy |
| Archive-derived media and archive/import/media-processing work | NAS-required | `WillardAI/temp/` / filesystem | Bounded scratch; remove only after owner completion/cancellation |
| Archive indexes and reports | NAS-required | `WillardAI/archive-index/`, `reports/` | Bounded retention, never originals |
| Logs and scan history | NAS-required | `WillardAI/logs/`, `scan-history/` | Bounded retention only |
| Face model cache | Bounded-local | `~/.cache/willard-face-models/` / filesystem | Re-download after verified removal |
| Branding assets | Control-plane-local | API data directory / filesystem | Size-limited; not a media fallback |
| Desktop launcher state/logs | Control-plane-local | `%LOCALAPPDATA%/Willard Media Center/` | Preserve startup/update recovery state |
| Installer/update staging | Bounded-local | Desktop `updates/` / filesystem | Apply update recovery rules only |
| Browser state/app-shell cache | Browser/device-local | Cache Storage and `localStorage` | Rebuildable |
| Browser exports/downloads | Browser/device-local | User-selected browser download target | User-controlled |
| Mobile session/chat identifiers | Browser/device-local | Mobile AsyncStorage | Rebuildable identifiers only |

The API reports current and projected usage per row. Filesystem accounting is
bounded and non-destructive; when a walk or database measurement is unavailable
the row is marked `unavailable` rather than guessed. The overall capacity
comes from the configured library filesystem, and the report never returns the
raw configured path or filenames.

## Enforcement rules

1. Original media, recycle contents, verified backups, manual metadata, catalog
   identity, albums/tags, archive history, and job state are protected. No
   capacity routine may delete them.
2. NAS-required scratch and derivative writes must fail with an explicit
   storage-policy error when the NAS is missing, inaccessible, or read-only.
   They must not fall back to `%TEMP%`, `/tmp`, `%LOCALAPPDATA%`, browser
   storage, or an uncontrolled download.
3. The policy state is `READY`, `READ_ONLY`, `PAUSED`, or `UNCONFIGURED`.
   Failed job records include the state and a safe reason, while logs and
   diagnostics retain only redacted operational data.
4. Browser and mobile persistence contains only app state or explicit
   user-initiated exports. Media bytes and library knowledge remain server-side.
5. A completed full scan never starts an unbounded derivative sweep. Thumbnail
   requests are lazy, and a user-requested backfill processes at most 500 files
   per job so it can be paused, retried, or resumed safely.
6. A database backup bound to a configured library records the authenticated
   `WillardAI/config/library-identity.json` marker. Recovery requires the same
   marker plus explicit operator attestation of its authenticated library ID.
   It rejects missing, changed, unrelated, or incompatible material before
   mutating the empty restore target.