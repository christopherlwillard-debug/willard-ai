---
name: Node module-mock tests
description: The runtime flag required for deterministic Node test module mocks
---

Tests that use Node's `mock.module` API must be run with `--experimental-test-module-mocks` in addition to `--experimental-strip-types`.

**Why:** Without the module-mocking flag, Node reports the test file path as unavailable instead of executing the test.

**How to apply:** Include both flags when running these focused tests directly, and preserve the module mocks' registration before dynamically importing the module under test.