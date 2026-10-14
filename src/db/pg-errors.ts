export interface PgErrorLike {
  code: string;
  constraint?: string | undefined;
}

/**
 * Find the underlying PostgreSQL error. Drizzle wraps driver errors, so walk
 * the `cause` chain looking for a 5-character SQLSTATE code.
 */
export function findPgError(err: unknown): PgErrorLike | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const e = current as { code?: unknown; constraint?: string; cause?: unknown };
    if (typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code)) {
      return { code: e.code, constraint: e.constraint };
    }
    current = e.cause;
  }
  return undefined;
}

export const PgErrorCodes = {
  UNIQUE_VIOLATION: "23505",
  CHECK_VIOLATION: "23514",
  NUMERIC_OUT_OF_RANGE: "22003",
  /** lock_timeout exceeded (or NOWAIT failed). */
  LOCK_NOT_AVAILABLE: "55P03",
  /** statement_timeout exceeded (or query cancelled). */
  QUERY_CANCELED: "57014",
} as const;

/** True if `err` is a unique violation, optionally on a specific constraint. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const pg = findPgError(err);
  return pg?.code === PgErrorCodes.UNIQUE_VIOLATION && (constraint === undefined || pg.constraint === constraint);
}
