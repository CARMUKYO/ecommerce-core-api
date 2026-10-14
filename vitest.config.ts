import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Shorter lock timeout keeps the 503 SERVICE_BUSY test fast; race tests hold locks < 1s.
    env: { NODE_ENV: "test", DB_LOCK_TIMEOUT_MS: "2000" },
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    // All integration tests share one real Postgres database; run files
    // serially so TRUNCATE in one file can't wipe another file's fixtures.
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
