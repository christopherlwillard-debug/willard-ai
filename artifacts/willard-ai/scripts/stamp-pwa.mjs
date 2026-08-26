import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const distDir = resolve("dist/public");
const indexPath = resolve(distDir, "index.html");
const workerPath = resolve(distDir, "sw.js");
const [indexHtml, workerSource] = await Promise.all([
  readFile(indexPath, "utf8"),
  readFile(workerPath, "utf8"),
]);

const configuredRelease = process.env.WILLARD_RELEASE_ID?.trim();
const revision = configuredRelease
  ? configuredRelease.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80)
  : createHash("sha256").update(indexHtml).update(workerSource).digest("hex").slice(0, 16);

const stampedWorker = workerSource.replace(
  'const VERSION = "willard-shell-dev";',
  `const VERSION = "willard-shell-${revision}";`,
);

if (stampedWorker === workerSource) {
  throw new Error("Could not find the service worker version placeholder.");
}

await writeFile(workerPath, stampedWorker);
console.log(`[pwa] stamped shell cache revision ${revision}`);