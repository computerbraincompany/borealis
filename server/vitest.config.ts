import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/tests/**/*.test.ts"],
    // config.ts throws at import when JWT_SECRET is missing/short — set before modules load.
    env: {
      JWT_SECRET: "vitest-secret-that-is-longer-than-32-chars-123456",
      PYTHON_SERVICE_TOKEN: "vitest-python-token-that-is-longer-than-32-chars",
      LITELLM_API_KEY: "vitest-litellm-token-that-is-longer-than-32-chars",
    },
  },
});
