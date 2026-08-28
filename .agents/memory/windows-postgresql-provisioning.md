---
name: Windows PostgreSQL provisioning
description: CI behavior to account for when provisioning PostgreSQL on hosted Windows release runners
---

Hosted Windows release runners can stall during a remote Chocolatey PostgreSQL package install after the package-download message, producing no useful installer error before the workflow timeout.

**Why:** The release job can fail before any application, backend, browser, packaging, or installer gate runs, so the result is a CI provisioning blocker rather than evidence of a Media Center defect.

**How to apply:** Keep PostgreSQL provisioning bounded and observable, with retries or a stable cached/preinstalled path and diagnostic output before treating downstream release gates as unvalidated.

Windows `psql` treats a connection URL supplied as the first positional argument
as the database name and can ignore flags that follow it, potentially waiting
indefinitely. Pass `--dbname`, `--command`, and other options by name.

**Why:** The same fixture command worked on Linux but waited on Windows until
the release gate stopped it, obscuring the actual test result.

**How to apply:** Keep Windows database fixture commands argument-safe and
bounded; never rely on options appearing after a positional connection URL.

The backend audit starts from the API package directory, so workspace-level E2E
fixtures must explicitly run with the repository root as their working
directory.

**Why:** Otherwise relative assets such as `test-media` are looked up under
`artifacts/api-server`, causing a false release failure.

**How to apply:** Set the child process working directory based on whether the
test belongs to the API package or the workspace E2E suite.