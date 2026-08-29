import { createContainedDownloadManager } from "./downloadManager.js";
import { createContainedEngineManager } from "./engineManager.js";
import { getRuntimeSettings, runtimeSettingsStore } from "../runtimeSettings.js";

/**
 * Process-wide contained-model singletons. The routes and the ambient status
 * surface share these instances so state is coherent across the API.
 */

export const downloadManager = createContainedDownloadManager();

function createLiveEndpointApply() {
  let previousBaseUrl: string | null = null;
  return {
    async isEndpointEnvManaged(): Promise<boolean> {
      const snapshot = await getRuntimeSettings();
      return snapshot.environmentOverrides.includes("llm_base_url");
    },
    async applyEndpoint(engineBaseUrl: string): Promise<void> {
      const snapshot = await getRuntimeSettings();
      previousBaseUrl = snapshot.settings.llmBaseUrl === engineBaseUrl ? previousBaseUrl : snapshot.settings.llmBaseUrl;
      await runtimeSettingsStore().patch({ llmBaseUrl: engineBaseUrl });
    },
    async restoreEndpoint(engineBaseUrl: string): Promise<void> {
      if (previousBaseUrl === null) return;
      const snapshot = await getRuntimeSettings();
      if (snapshot.settings.llmBaseUrl !== engineBaseUrl) return;
      await runtimeSettingsStore().patch({ llmBaseUrl: previousBaseUrl });
      previousBaseUrl = null;
    },
  };
}

const endpointApply = createLiveEndpointApply();

export const engineManager = createContainedEngineManager({
  isEndpointEnvManaged: endpointApply.isEndpointEnvManaged,
  applyEndpoint: endpointApply.applyEndpoint,
  restoreEndpoint: endpointApply.restoreEndpoint,
});
