import { defineConfig } from "vitest/config";

/**
 * PostgreSQL-backed tests. They share one database, so files run one at a
 * time. Without FLIGHTMAP_TEST_DATABASE_URL every suite skips itself.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/integration/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
});
