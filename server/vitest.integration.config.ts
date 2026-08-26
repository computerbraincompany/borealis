import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/tests/chatStore.test.ts",
      "src/tests/runStore.test.ts",
      "src/tests/sqliteFoundation.test.ts",
      "src/tests/sqliteSourceStore.test.ts",
      "src/tests/sourceIngestionTransitions.test.ts",
      "src/tests/ingestionVectorLifecycle.test.ts",
      "src/tests/lanceVectorIndex.test.ts",
    ],
    fileParallelism: false,
    maxWorkers: 1,
    env: {
      JWT_SECRET: "vitest-secret-that-is-longer-than-32-chars-123456",
      LITELLM_API_KEY: "vitest-model-token-that-is-longer-than-32-chars",
      LLM_BASE_URL: "http://127.0.0.1:1234",
      LM_STUDIO_BASE_URL: "http://localhost:1234",
    },
  },
});
