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
