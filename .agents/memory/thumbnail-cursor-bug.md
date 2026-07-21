---
name: Thumbnail cursor bug pattern
description: runThumbnailJob cursor-resume must only pick up from restart-interrupted jobs; monitor must cancel (not pause) thumbnail jobs when NAS goes offline
---

## The cursor-resume bug pattern

`runThumbnailJob` originally loaded cursor from ANY previous THUMBNAILS job.
After a completed pass cursor=max_file_id. New job runs `WHERE id > max_id
AND thumbnailPath IS NULL` → 0 rows → exits with 0 thumbnails immediately.
This is the "0 of 24,489 forever" symptom after clearing the thumbnail cache.

**Rule:** Only resume cursor from FAILED jobs with `error LIKE '%Interrupted by
server restart%'`. Never from DONE, CANCELLED, or NAS_OFFLINE-failed jobs.

**Why:** Completed jobs' cursors are poisonous — they sit at max_id and
silently kill the next run. Only restart-interrupted jobs have a cursor that
points to genuinely unprocessed files.

## Monitor must cancel, not pause, thumbnail jobs

When NAS goes offline, `requestPause` on a THUMBNAILS job causes it to enter
a spin-loop (pauseRequested=true). The monitor's reconnect handler starts a
QUICK SCAN, not `resumeJob`. The paused thumbnail stays in memory forever.
`isThumbRunning` sees it → never starts a new one.

**Rule:** On NAS offline, check `getActiveJobType()`. SCAN jobs → requestPause.
THUMBNAILS/METADATA jobs → requestCancel("NAS_OFFLINE"). After reconnect, the
QUICK scan completes → isThumbRunning=false → auto-starts fresh thumbnail job
with cursor=0.

**Why:** Thumbnail/metadata jobs handle per-file errors gracefully (each file
wrapped in try/catch). Pausing them creates an unresumable stuck state because
the monitor's reconnect path calls startJob (new scan), not resumeJob.

## ActiveJobState requires jobType field

The `jobType` field was missing from `ActiveJobState`. Without it, the monitor
cannot determine whether the active job is a scan vs thumbnail vs metadata,
making type-sensitive decisions (pause vs cancel) impossible.

**How to apply:** Always include `jobType` when constructing ActiveJobState in
`startJob` and `resumeJob`. Use `getActiveJobType()` wherever job-type-specific
behavior is needed in monitors or other observers.
