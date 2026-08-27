import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const STORAGE_CONFORMANCE_PATH = path.join(root, "storage-conformance.json");

export function loadStorageConformance() {
  return JSON.parse(readFileSync(STORAGE_CONFORMANCE_PATH, "utf8"));
}

export function validateStorageConformance(matrix, { rootDir = root } = {}) {
  const errors = [];
  const requiredFields = [
    "pipeline",
    "modes",
    "destination",
    "retention",
    "capacityGuard",
    "nasOffline",
    "resume",
    "duplicateProtection",
    "automaticReclaimSource",
    "automatedChecks",
  ];
  const entries = Array.isArray(matrix?.entries) ? matrix.entries : [];
  const requiredPipelines = new Set(matrix?.requiredPipelines || []);
  const actualPipelines = new Set(entries.map((entry) => entry?.pipeline));
  const scenarios = Array.isArray(matrix?.requiredScenarios) ? matrix.requiredScenarios : [];

  if (matrix?.format !== 1) errors.push("storage conformance matrix format must be 1");
  if (!matrix?.policyVersion) errors.push("storage conformance matrix is missing policyVersion");
  if (!Array.isArray(matrix?.modes) || matrix.modes.length === 0) {
    errors.push("storage conformance matrix must define supported modes");
  }
  if (requiredPipelines.size !== actualPipelines.size ||
      [...requiredPipelines].some((pipeline) => !actualPipelines.has(pipeline))) {
    errors.push("requiredPipelines must match the matrix entries exactly");
  }
  const scenarioIds = new Set();
  for (const scenario of scenarios) {
    if (!scenario?.id || !scenario?.mode || !scenario?.evidence) {
      errors.push("every required scenario needs an id, mode, and evidence path");
      continue;
    }
    if (scenarioIds.has(scenario.id)) errors.push(`duplicate required scenario: ${scenario.id}`);
    scenarioIds.add(scenario.id);
    if (!matrix.modes?.includes(scenario.mode)) {
      errors.push(`${scenario.id} references an unsupported mode`);
    }
    try {
      const absolute = path.resolve(rootDir, scenario.evidence);
      if (!absolute.startsWith(`${rootDir}${path.sep}`) || !readFileSync(absolute)) {
        errors.push(`${scenario.id} references an unreadable evidence file: ${scenario.evidence}`);
      }
    } catch {
      errors.push(`${scenario.id} references a missing evidence file: ${scenario.evidence}`);
    }
  }
  if (scenarioIds.size !== 18) errors.push("requiredScenarios must contain all 18 target-environment checks");

  const seen = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      errors.push("matrix entries must be objects");
      continue;
    }
    if (seen.has(entry.pipeline)) errors.push(`duplicate matrix entry: ${entry.pipeline}`);
    seen.add(entry.pipeline);
    for (const field of requiredFields) {
      const value = entry[field];
      if (Array.isArray(value) ? value.length === 0 : typeof value !== "string" || !value.trim()) {
        errors.push(`${entry.pipeline || "<unknown>"} is missing ${field}`);
      }
    }
    if (!Array.isArray(entry.modes) || entry.modes.some((mode) => !matrix.modes.includes(mode))) {
      errors.push(`${entry.pipeline || "<unknown>"} references an unsupported mode`);
    }
    if (entry.pipeline !== "exports" && entry.pipeline !== "operational-logs-and-reports" &&
        !entry.destination.includes("NAS_LIBRARY")) {
      errors.push(`${entry.pipeline} must name a NAS-backed destination`);
    }
    if (entry.pipeline !== "exports" && entry.pipeline !== "operational-logs-and-reports" &&
        entry.capacityGuard.toLowerCase().includes("local fallback")) {
      errors.push(`${entry.pipeline} must not permit a local media fallback`);
    }
    for (const check of entry.automatedChecks || []) {
      try {
        const absolute = path.resolve(rootDir, check);
        if (!absolute.startsWith(`${rootDir}${path.sep}`) || !readFileSync(absolute)) {
          errors.push(`${entry.pipeline} references an unreadable check: ${check}`);
        }
      } catch {
        errors.push(`${entry.pipeline} references a missing check: ${check}`);
      }
    }
  }
  return errors;
}

export function assertStorageConformance(matrix = loadStorageConformance(), options) {
  const errors = validateStorageConformance(matrix, options);
  if (errors.length > 0) {
    throw new Error(`Storage-policy conformance matrix is incomplete:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  }
  return matrix;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assertStorageConformance();
  console.log("Storage-policy conformance matrix is complete.");
}