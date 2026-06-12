/**
 * Drizzle + postgres.js client. One pool per process; mirrors the Go server's
 * pgxpool wiring.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export interface DbHandle {
  db: ReturnType<typeof drizzle<typeof schema>>;
  sql: ReturnType<typeof postgres>;
  close: () => Promise<void>;
}

export function createDb(databaseUrl: string, max = 10): DbHandle {
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const sql = postgres(databaseUrl, { max });
  const db = drizzle(sql, { schema });
  return { db, sql, close: () => sql.end() };
}

export type Db = DbHandle["db"];
