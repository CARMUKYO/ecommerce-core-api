import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { env } from "../config/env.js";
import * as schema from "./schema/index.js";

// BIGINT (int8, OID 20) columns hold cents aggregates. Parse them as JS numbers;
// Number.MAX_SAFE_INTEGER cents (~$90 trillion) is far beyond any realistic total.
pg.types.setTypeParser(20, (value) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError(`BIGINT value ${value} exceeds safe integer range`);
  return n;
});

export const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 20 });

export type Database = NodePgDatabase<typeof schema>;
export const db: Database = drizzle(pool, { schema, casing: "snake_case" });

/** Drizzle transaction handle type, for repositories that participate in a caller's transaction. */
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
/** Anything that can run queries: the root db or an open transaction. */
export type DbExecutor = Database | Tx;

export async function closeDb(): Promise<void> {
  await pool.end();
}
