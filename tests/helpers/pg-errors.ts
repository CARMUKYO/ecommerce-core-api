import { expect } from "vitest";

export const PG = {
  UNIQUE_VIOLATION: "23505",
  FOREIGN_KEY_VIOLATION: "23503",
  /** Raised by `ON DELETE RESTRICT` (vs 23503 for the default NO ACTION). */
  RESTRICT_VIOLATION: "23001",
  CHECK_VIOLATION: "23514",
  NOT_NULL_VIOLATION: "23502",
} as const;

interface PgErrorLike {
  code?: string;
  constraint?: string;
  cause?: unknown;
}

/** Drizzle wraps driver errors; walk the `cause` chain to find the pg error. */
export function findPgError(err: unknown): PgErrorLike | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const e = current as PgErrorLike;
    if (typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code)) return e;
    current = e.cause;
  }
  return undefined;
}

export async function expectPgError(
  operation: Promise<unknown>,
  expected: { code: string; constraint?: string },
): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (err) {
    caught = err;
  }
  expect(caught, "expected the database to reject this operation").toBeDefined();
  const pgErr = findPgError(caught);
  expect(pgErr, `expected a PostgreSQL error, got: ${String(caught)}`).toBeDefined();
  expect(pgErr!.code).toBe(expected.code);
  if (expected.constraint) expect(pgErr!.constraint).toBe(expected.constraint);
}
