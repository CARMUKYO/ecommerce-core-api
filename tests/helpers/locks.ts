import { pool } from "../../src/db/client.js";

/**
 * Open a transaction on a dedicated connection and run `sql` in it, holding
 * whatever row locks it takes until `commit()` or `rollback()`. Used to force
 * deterministic interleavings in race tests.
 */
export async function holdInTransaction(sql: string, params: unknown[]) {
  const client = await pool.connect();
  await client.query("BEGIN");
  await client.query(sql, params);
  const finish = async (cmd: "COMMIT" | "ROLLBACK") => {
    await client.query(cmd);
    client.release();
  };
  return { commit: () => finish("COMMIT"), rollback: () => finish("ROLLBACK") };
}

/** Wait until `n` backends are blocked on locks. */
export async function waitForLockWaiters(n: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const { rows } = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
    );
    if ((rows[0]?.n ?? 0) >= n) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out waiting for ${n} lock waiter(s)`);
}
