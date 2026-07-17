import { defineConfig } from "drizzle-kit";
import { readFileSync } from "fs";
import path from "path";

// Auto-load the root .env so `pnpm --filter @workspace/db run push` works
// on a fresh Windows clone without manually exporting DATABASE_URL first.
// drizzle-kit runs with cwd = lib/db/, so root .env is two levels up.
if (!process.env.DATABASE_URL) {
  try {
    const envPath = path.resolve(process.cwd(), "../../.env");
    const lines = readFileSync(envPath, "utf-8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (key && !process.env[key]) process.env[key] = val;
    }
  } catch { /* .env not found — rely on DATABASE_URL being pre-set */ }
}

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  schema: "./src/schema/index.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
