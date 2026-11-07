import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const routePath = fileURLToPath(new URL("../routes/storage.ts", import.meta.url));
const source = readFileSync(routePath, "utf8");

test("storage endpoints use the canonical active-library settings resolver", () => {
  assert.match(source, /import \{ getActiveNasPath \} from "\.\.\/lib\/active-library\.ts"/);
  assert.match(source, /async function getNasPath\(\): Promise<string \| null> \{\s*return getActiveNasPath\(\);/);
  assert.doesNotMatch(source, /appSettingsTable|\.from\(appSettingsTable\)/);
});
