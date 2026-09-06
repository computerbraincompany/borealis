/**
 * Single membership authority for the server Vitest suites.
 *
 * Both `vitest.config.ts` and `vitest.integration.config.ts` import these
 * values so the unit and integration runs stay disjoint. Keep this module
 * free of Vitest runtime configuration and environment values.
 */

/** Broad include glob for the default (unit) server suite. */
export const SERVER_TEST_GLOB = "src/tests/**/*.test.ts";

/**
 * Files that require the serialized native-store environment
 * (`fileParallelism: false`, `maxWorkers: 1`). Paths are forward-slash
 * relative to `server/`.
 */
export const INTEGRATION_TEST_FILES = Object.freeze([
  "src/tests/applicationRuntime.test.ts",
  "src/tests/chatStore.test.ts",
  "src/tests/runStore.test.ts",
  "src/tests/sqliteFoundation.test.ts",
  "src/tests/sqliteSourceStore.test.ts",
  "src/tests/sourceIngestionTransitions.test.ts",
  "src/tests/ingestionVectorLifecycle.test.ts",
  "src/tests/lanceVectorIndex.test.ts",
  "src/tests/agentVerticalIntegration.test.ts",
] as const);
