import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "../..");
const GENERATED_API_FILES = [
  "lib/api-client-react/src/generated/api.ts",
  "lib/api-zod/src/generated/api.ts",
];

function exportedDeclarations(source) {
  const declarations = [];
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const match = line.match(/^export\s+(?:declare\s+)?(?:const|let|var|function|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)\b/);
    if (match) declarations.push({ name: match[1], line: index + 1 });
  }
  return declarations;
}

test("generated API modules do not redeclare exported symbols", async () => {
  for (const relativePath of GENERATED_API_FILES) {
    const source = await readFile(path.join(ROOT, relativePath), "utf8");
    const declarations = exportedDeclarations(source);
    assert.ok(declarations.length > 0, \`\${relativePath} contains no exported declarations\`);

    const byName = new Map();
    for (const declaration of declarations) {
      const locations = byName.get(declaration.name) ?? [];
      locations.push(declaration.line);
      byName.set(declaration.name, locations);
    }

    const duplicates = [...byName]
      .filter(([, locations]) => locations.length > 1)
      .map(([name, locations]) => ({ name, lines: locations }));

    assert.deepEqual(
      duplicates,
      [],
      \`\${relativePath} contains duplicate generated exports\`,
    );
  }
});
