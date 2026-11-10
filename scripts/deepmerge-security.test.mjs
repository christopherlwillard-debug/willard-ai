import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const mobileRequire = createRequire(new URL("../artifacts/willard-mobile/package.json", import.meta.url));
const expoCliRequire = createRequire(mobileRequire.resolve("@expo/cli"));
const expoConfigRequire = createRequire(expoCliRequire.resolve("@expo/config"));
const deepmerge = expoConfigRequire("deepmerge");

test("Expo's deepmerge rejects prototype-mutating keys for normal and null-prototype targets", () => {
  for (const target of [{}, Object.create(null)]) {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const payload = JSON.parse(JSON.stringify({
        [key]: { prototype: { willardProbe: "poisoned" } },
      }));
      const result = deepmerge(target, payload);
      assert.equal(Object.hasOwn(result, key), false, `${key} must not be copied into the merged object`);
      assert.equal(result.willardProbe, undefined);
      assert.equal(({}).willardProbe, undefined);
    }
  }
});

test("Expo's deepmerge still combines ordinary nested configuration", () => {
  assert.deepEqual(
    deepmerge({ nested: { enabled: true }, list: [1] }, { nested: { label: "ok" }, list: [2] }),
    { nested: { enabled: true, label: "ok" }, list: [1, 2] },
  );
});
