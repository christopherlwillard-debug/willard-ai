import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "../..");
const ROUTES_ROOT = path.join(ROOT, "artifacts/api-server/src/routes");
const SPEC_PATH = path.join(ROOT, "lib/api-spec/openapi.yaml");
const GENERATED_REACT_PATH = path.join(ROOT, "lib/api-client-react/src/generated/api.ts");
const METHODS = ["get", "post", "put", "patch", "delete"];

async function routeFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await routeFiles(fullPath));
    else if (entry.name.endsWith(".ts")) files.push(fullPath);
  }
  return files;
}

function normalizePath(routePath) {
  return routePath.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

async function readRuntimeRoutes() {
  const declarations = [];
  for (const file of await routeFiles(ROUTES_ROOT)) {
    const source = await readFile(file, "utf8");
    const pattern = /router\.(get|post|put|patch|delete)\(\s*(["'`])([^"'`]+)\2/g;
    for (const match of source.matchAll(pattern)) {
      declarations.push({
        method: match[1].toUpperCase(),
        path: normalizePath(match[3]),
        file: path.relative(ROOT, file),
      });
    }
  }
  return declarations;
}

function readSpecOperations(source) {
  const operations = [];
  let currentPath = null;
  let currentOperation = null;

  for (const line of source.split(/\r?\n/)) {
    const pathMatch = line.match(/^  (\/[^:]+):$/);
    if (pathMatch) {
      currentPath = pathMatch[1];
      currentOperation = null;
      continue;
    }

    const methodMatch = line.match(/^    (get|post|put|patch|delete):(?:\s|$)/);
    if (methodMatch && currentPath) {
      currentOperation = {
        method: methodMatch[1].toUpperCase(),
        path: currentPath,
        operationId: line.match(/operationId:\s*([A-Za-z0-9_]+)/)?.[1] ?? null,
      };
      operations.push(currentOperation);
      continue;
    }

    const operationIdMatch = line.match(/^      operationId:\s*([A-Za-z0-9_]+)/);
    if (operationIdMatch && currentOperation) currentOperation.operationId = operationIdMatch[1];
  }

  return operations;
}

function key(operation) {
  return `${operation.method} ${operation.path}`;
}

test("every mounted route operation has an OpenAPI contract", async () => {
  const [runtimeRoutes, specSource] = await Promise.all([
    readRuntimeRoutes(),
    readFile(SPEC_PATH, "utf8"),
  ]);
  const specOperations = readSpecOperations(specSource);
  const runtimeKeys = new Set(runtimeRoutes.map(key));
  const specKeys = new Set(specOperations.map(key));

  assert.deepEqual(
    [...runtimeKeys].filter((route) => !specKeys.has(route)).sort(),
    [],
    "runtime operations missing from OpenAPI",
  );
  assert.deepEqual(
    [...specKeys].filter((route) => !runtimeKeys.has(route)).sort(),
    [],
    "OpenAPI operations without a mounted runtime route",
  );
});

test("every contracted operation has a unique operationId and generated client entry", async () => {
  const [specSource, generatedReact] = await Promise.all([
    readFile(SPEC_PATH, "utf8"),
    readFile(GENERATED_REACT_PATH, "utf8"),
  ]);
  const operations = readSpecOperations(specSource);
  const operationIds = operations.map((operation) => operation.operationId);

  assert.ok(operationIds.every(Boolean), "every OpenAPI operation must declare operationId");
  assert.equal(new Set(operationIds).size, operationIds.length, "OpenAPI operationId values must be unique");

  const missingGenerated = operationIds.filter(
    (operationId) => !generatedReact.includes(`export const ${operationId} =`),
  );
  assert.deepEqual(missingGenerated, [], "generated React client is missing OpenAPI operations");
});
