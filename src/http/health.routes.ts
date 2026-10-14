import { sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { db } from "../db/client.js";
import { AppError, ErrorCodes } from "./errors.js";

/** Probes for orchestrators/load balancers. Exempt from rate limiting. */
export const healthRoutes: FastifyPluginAsync = async (app) => {
  // Liveness: the process is up and serving.
  app.get("/health", { config: { rateLimit: false } }, async () => ({ status: "ok" }));

  // Readiness: the database answers. Fails with 503 so traffic is routed elsewhere.
  app.get("/ready", { config: { rateLimit: false } }, async () => {
    try {
      await db.execute(sql`SELECT 1`);
    } catch {
      throw new AppError({ statusCode: 503, code: ErrorCodes.SERVICE_BUSY, message: "Database is not reachable" });
    }
    return { status: "ready" };
  });
};
