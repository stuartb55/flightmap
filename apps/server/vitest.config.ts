import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // PostgreSQL-backed suites have their own config; see vitest.integration.config.ts.
    exclude: ["test/integration/**"],
    coverage: {
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/**/*-cli.ts"],
      // A point of headroom below the current figures: these guard against a
      // real regression, not against rounding.
      thresholds: {
        lines: 54,
        functions: 48,
        branches: 45,
        statements: 53
      }
    }
  }
});
