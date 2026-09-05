import { configDefaults, defineConfig } from "vitest/config";
import { INTEGRATION_TEST_FILES, SERVER_TEST_GLOB } from "./src/tests/vitestTestPartitions.js";

export default defineConfig({
  test: {
    environment: "node",
    include: [SERVER_TEST_GLOB],
    // The serialized integration files run only under
    // vitest.integration.config.ts; Vitest's default exclusions are kept.
    exclude: [...configDefaults.exclude, ...INTEGRATION_TEST_FILES],
    // Keep direct app-construction tests on an environment-owned secret; file-
    // backed secrets are intentionally initialized only after the workspace lock.
    env: {
      JWT_SECRET: "vitest-secret-that-is-longer-than-32-chars-123456",
      LITELLM_API_KEY: "vitest-model-token-that-is-longer-than-32-chars",
      LLM_BASE_URL: "http://127.0.0.1:1234",
      LM_STUDIO_BASE_URL: "http://localhost:1234",
    },
  },
});
