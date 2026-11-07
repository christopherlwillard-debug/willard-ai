import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const routePath = fileURLToPath(new URL("../routes/settings.ts", import.meta.url));
const source = readFileSync(routePath, "utf8");

test("changing the NAS library invalidates the media route path cache after persistence", () => {
  assert.match(source, /import \{ invalidateNasPathCache \} from "\.\/media"/);
  assert.match(source, /if \(normalizedNasPath && normalizedNasPath !== existing\.nasPath\) \{\s*invalidateNasPathCache\(\);/);
  assert.ok(source.indexOf(".returning();") < source.indexOf("invalidateNasPathCache();"));
});
