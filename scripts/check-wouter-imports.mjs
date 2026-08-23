import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const sourceRoot = path.resolve("artifacts/willard-ai/src");
const violations = [];

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await visit(entryPath);
      continue;
    }
    if (!/\.(?:ts|tsx|js|jsx)$/.test(entry.name)) continue;
    const source = await readFile(entryPath, "utf8");
    if (
      /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']react-router-dom["']/.test(
        source,
      )
    ) {
      violations.push(path.relative(process.cwd(), entryPath));
    }
  }
}
await visit(sourceRoot);

if (violations.length > 0) {
  console.error(
    `Found react-router-dom imports under ${path.relative(process.cwd(), sourceRoot)}:\n` +
      violations.map((file) => `- ${file}`).join("\n"),
  );
  process.exitCode = 1;
} else {
  console.log("Router import audit passed: all web source uses wouter.");
}
