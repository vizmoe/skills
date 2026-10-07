import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: "forks",
    maxWorkers: 2,
    coverage: {
      provider: "v8",
      include: ["packages/core/src/**/*.ts", "packages/cli/src/**/*.ts"],
      reporter: ["text-summary", "json-summary", "html", "lcov"],
      reportsDirectory: "dist/coverage",
      thresholds: { statements: 71, branches: 65, functions: 79, lines: 71 },
    },
  },
});
