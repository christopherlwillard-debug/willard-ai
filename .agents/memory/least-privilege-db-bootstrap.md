---
name: Least-privilege database bootstrap
description: Why local setup checks the configured PostgreSQL database before using the maintenance database.
---

Database bootstrap must connect to the configured target database first. It may use the `postgres` maintenance database to inspect or create the target only when the target connection fails with PostgreSQL SQLSTATE `3D000` (database does not exist).

**Why:** A correctly restricted application role may have access to its existing database but no access to `postgres` and no `CREATEDB` privilege. Contacting the maintenance database unconditionally makes a healthy least-privilege installation fail setup.

**How to apply:** Keep standalone setup and launcher recovery behavior aligned. Existing targets require only target access; missing targets report distinct guidance for maintenance-database access and `CREATEDB` failures.