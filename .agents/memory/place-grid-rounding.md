---
name: Place grid rounding parity
description: Coordinate cache keys must preserve JavaScript/Postgres rounding parity at negative half-cell boundaries.
---

Use JavaScript rounding semantics for the shared place-grid key and normalize
negative zero to zero. PostgreSQL's `floor(value * 10 + 0.5)::int` agrees on
the bucket but cannot represent `-0`, so an unnormalized JavaScript result can
fail exact parity checks even though string keys currently happen to match.

**Why:** Southern and western hemisphere coordinates at exact `.x5` values
were the edge case most likely to silently split reverse-geocode cache keys.

**How to apply:** When changing place bucketing, test positive and negative
coordinates, including exact half-values, against the SQL expression.