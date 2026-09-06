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
  "src/tests/analysisRunner.test.ts",
  "src/tests/analysisStartupWindow.test.ts",
  "src/tests/analysisStore.test.ts",
  "src/tests/applicationRuntime.test.ts",
  "src/tests/briefRecipes.test.ts",
  "src/tests/chatStore.test.ts",
  "src/tests/connectionStore.test.ts",
  "src/tests/connectorRefreshStore.test.ts",
  "src/tests/documentRewriteRunner.test.ts",
  "src/tests/documentStore.test.ts",
  "src/tests/documents.test.ts",
  "src/tests/knowledgeFolder.test.ts",
  "src/tests/knowledgeGrants.test.ts",
  "src/tests/knowledgeRefresh.test.ts",
  "src/tests/knowledgeStore.test.ts",
  "src/tests/knowledgeWebdav.test.ts",
  "src/tests/researchStore.test.ts",
  "src/tests/runStore.test.ts",
  "src/tests/sqliteFoundation.test.ts",
  "src/tests/sqliteSourceStore.test.ts",
  "src/tests/sourceIngestionTransitions.test.ts",
  "src/tests/ingestionVectorLifecycle.test.ts",
  "src/tests/lanceVectorIndex.test.ts",
  "src/tests/mcpClient.test.ts",
  "src/tests/mcpOAuth.test.ts",
  "src/tests/mcpAgentTurn.test.ts",
  "src/tests/agentVerticalIntegration.test.ts",
  "src/tests/shutdownDrain.test.ts",
  "src/tests/sourceSearch.integration.test.ts",
] as const);
