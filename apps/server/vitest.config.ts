import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/**/*-cli.ts"],
      thresholds: {
        lines: 48,
        functions: 43,
        branches: 44,
        statements: 47
      }
    }
  }
});
