import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/index.ts";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });

let poolClosePromise: Promise<void> | null = null;

/** Close the shared pool exactly once during an orderly process shutdown. */
export function closePool(): Promise<void> {
  if (!poolClosePromise) {
    poolClosePromise = pool.end();
  }
  return poolClosePromise;
}

export * from "./schema/index.ts";
