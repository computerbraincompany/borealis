import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/tests/**/*.integration.ts"],
    setupFiles: ["./src/tests/integrationSetup.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    env: { JWT_SECRET: "vitest-secret-that-is-longer-than-32-chars-123456" },
  },
});
