import { buildApp } from "./app.js";
import { env } from "./config/env.js";
import { closeDb } from "./db/client.js";
import { jobs, JobScheduler } from "./jobs/scheduler.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;

const app = buildApp({
  logger: {
    level: env.NODE_ENV === "development" ? "debug" : "info",
  },
  trustProxy: env.TRUST_PROXY,
});

const scheduler = new JobScheduler(jobs, app.log);

/**
 * Graceful shutdown: stop accepting connections, let in-flight requests and
 * jobs finish, then close the pool. Force-exit if that takes too long.
 */
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down");

  const force = setTimeout(() => {
    app.log.error("graceful shutdown timed out; forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  force.unref();

  try {
    await scheduler.stop();
    await app.close();
    await closeDb();
    app.log.info("shutdown complete");
  } catch (err) {
    app.log.error({ err }, "error during shutdown");
    process.exitCode = 1;
  }
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  app.log.error({ err: reason }, "unhandled promise rejection");
});

async function main() {
  try {
    await app.listen({ port: env.PORT, host: "0.0.0.0" });
    if (env.JOBS_ENABLED) scheduler.start();
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
