import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    hookTimeout: 180_000,
    include: ["test/e2e/**/*.test.ts"],
    testTimeout: 240_000,
  },
});
