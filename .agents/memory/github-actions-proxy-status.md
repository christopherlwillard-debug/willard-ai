---
name: GitHub Actions status through the workspace proxy
description: Reliable status and log polling when the standard GitHub CLI watcher is rate-limited.
---

In this workspace, `gh run watch` may poll the public GitHub API without authentication and fail with a 403 rate limit, while `gh api --hostname github.replit.internal` can access run and job status through the authenticated workspace proxy. The job-log endpoint may return 404 until the job completes; the completed run's logs endpoint returns the downloadable log bundle.

**Why:** A rate-limit error from the public endpoint does not mean the workflow itself failed, and the internal proxy provides a reliable way to monitor it.

**How to apply:** Poll `repos/<owner>/<repo>/actions/runs/<run-id>/jobs` through `gh api --hostname github.replit.internal`; after completion, download `repos/<owner>/<repo>/actions/runs/<run-id>/logs`.
