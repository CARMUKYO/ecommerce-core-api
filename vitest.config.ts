import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    env: { NODE_ENV: "test" },
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    // All integration tests share one real Postgres database; run files
    // serially so TRUNCATE in one file can't wipe another file's fixtures.
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
