import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/tests/**/*.test.ts"],
    // config.ts throws at import when JWT_SECRET is missing/short — set before modules load.
    env: {
      JWT_SECRET: "vitest-secret-that-is-longer-than-32-chars-123456",
      LITELLM_API_KEY: "vitest-model-token-that-is-longer-than-32-chars",
      LLM_BASE_URL: "http://127.0.0.1:1234",
      LM_STUDIO_BASE_URL: "http://localhost:1234",
    },
  },
});
