import "dotenv/config";
import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.url(),
  TEST_DATABASE_URL: z.url().optional(),
  CART_MAX_LINE_QUANTITY: z.coerce.number().int().min(1).max(999).default(99),
  // Absolute session lifetime. Default 7 days.
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 90).default(168),
  // Unpaid PENDING orders are auto-cancelled (stock released) after this long.
  PENDING_ORDER_TTL_MINUTES: z.coerce.number().int().min(1).max(60 * 24 * 7).default(30),
  // Background jobs (expiry sweepers). Never started by tests' buildApp().
  JOBS_ENABLED: z.stringbool().default(true),

  // Rate limiting. Defaults to on, except under NODE_ENV=test.
  RATE_LIMIT_ENABLED: z.stringbool().optional(),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(100),
  // Only trust X-Forwarded-For when actually behind a reverse proxy, or every
  // client could spoof its IP and dodge per-IP limits.
  TRUST_PROXY: z.stringbool().default(false),
  // Comma-separated browser origins allowed via CORS. Empty = no cross-origin access.
  CORS_ORIGINS: z
    .string()
    .default("")
    .transform((v) => v.split(",").map((o) => o.trim()).filter(Boolean)),

  // Postgres guards: no request may hold a connection or lock indefinitely.
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).default(10_000),
  DB_LOCK_TIMEOUT_MS: z.coerce.number().int().min(100).default(5_000),
  DB_IDLE_TX_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(30_000),
});

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // Fail fast at boot with a readable message rather than at first query.
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(parsed.error)}`);
  }
  const env = parsed.data;
  // Tests always run against the isolated test database.
  if (env.NODE_ENV === "test") {
    if (!env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is required when NODE_ENV=test");
    return { ...env, DATABASE_URL: env.TEST_DATABASE_URL };
  }
  return env;
}

export const env = loadEnv();
