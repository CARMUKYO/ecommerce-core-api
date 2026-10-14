import { pool } from "../db/client.js";

/**
 * Run `fn` only if no other process holds this job's Postgres advisory lock,
 * so with several app instances each job still runs at most once at a time.
 *
 * Uses a session-level lock on a dedicated connection (held across the job's
 * own short transactions) and always releases it. Returns `{ ran: false }` if
 * another instance is already running the job.
 */
export async function withJobLock<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<{ ran: true; result: T } | { ran: false }> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [`job:${name}`],
    );
    if (!rows[0]?.locked) return { ran: false };
    try {
      return { ran: true, result: await fn() };
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [`job:${name}`]);
    }
  } finally {
    client.release();
  }
}
