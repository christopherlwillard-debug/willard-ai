# Willard AI — Architecture Principles

Permanent, cross-cutting rules of the system. Every feature and every future
task must follow them. These are principles, not implementation notes — the
code may evolve, these rules do not.

## 1. Canonical Media Record
There is exactly one source-of-truth record per media item (the indexed media
file record). No feature keeps its own private copy of a file's metadata.
Features enrich the canonical record or reference it by id — they never fork it.

## 2. Background-first
Heavy work (scanning, indexing, hashing, thumbnailing, AI analysis) always runs
in background jobs. The UI never blocks on heavy work: it starts a job, shows
progress, and stays fully usable while the job runs.

## 3. Local-first processing
AI and media processing run locally (on the server the user controls) where
practical. Cloud services are an explicit, optional enhancement — never a
requirement for the core library experience.

## 4. Graceful degradation
Missing metadata, GPS, faces, thumbnails, or optional components (e.g. FFmpeg)
never break the UI or crash the server. Sections that lack data simply don't
render; missing tools produce a clear warning and reduced features, not errors.

## 5. Progressive loading
Show useful information immediately and enrich it over time. A freshly indexed
file appears with name/size/date first; thumbnails, EXIF, and AI enrichment
arrive as background work completes.

## 6. Incremental by default
Never rebuild what an incremental update can maintain. Scans re-process only
new, changed, or moved files; unchanged files are stamped, not re-read. Full
rebuilds are an explicit, rare user action — never the routine path.

## 7. User edits override AI
Manual corrections are preserved and always take precedence over AI-generated
values. AI output is stored separately (never destroyed) so it can be revisited,
but the user's word is final in every view.

## 8. Storage-agnostic
The library location is just a directory the server can read. WD My Cloud,
Synology, QNAP, USB drives, internal disks, and Windows shares are all equal
citizens. No feature may assume a specific brand, protocol, or mount type;
reachability is verified with live filesystem checks, never inferred.

## 9. Honest health, never silent failure
The app reports the library's real state (online, offline, indexing, paused)
everywhere it matters. When the library is unreachable, features say so plainly
and pause; they never pretend to work, fabricate results, or fail silently.
Reconnection is automatic and announced.
