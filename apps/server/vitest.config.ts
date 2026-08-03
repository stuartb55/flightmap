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
      thresholds: {
        lines: 55,
        functions: 49,
        branches: 46,
        statements: 54
      }
    }
  }
});
