---
name: Thumbnail restart checkpoint pattern
description: Thumbnail jobs use durable derivative pointers rather than numeric cursors across restarts; monitor cancellation rules remain job-type-sensitive
---

## The cursor-resume bug pattern

`runThumbnailJob` originally loaded a numeric cursor from previous jobs. A
completed cursor could skip every new cache miss, while an interrupted cursor
could strand failed rows below the checkpoint.

**Rule:** Start every thumbnail sweep at ID zero and treat a valid durable
`thumbnailPath` as the checkpoint. Reconcile published canonical files into the
catalog before counting pending work.

**Why:** Completed rows are naturally excluded without replaying expensive work,
while failed or interrupted rows remain eligible. A numeric cursor cannot
represent both states safely.

**How to apply:** Numeric cursors may optimize work inside one uninterrupted
run, but restart and pause recovery must re-sweep from zero and rely on valid
catalog pointers to skip completed derivatives.

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
