import { defineConfig } from "vitest/config";
import { INTEGRATION_TEST_FILES } from "./src/tests/vitestTestPartitions.js";

export default defineConfig({
  test: {
    environment: "node",
    include: [...INTEGRATION_TEST_FILES],
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
