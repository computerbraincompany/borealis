import { createContainedDownloadManager } from "./downloadManager.js";
import { createContainedEngineManager } from "./engineManager.js";
import { getRuntimeSettings, runtimeSettingsMutationStore } from "../runtimeSettings.js";
import {
  sameEffectiveLlmSettings,
  type EffectiveLlmSettings,
  type SettingsMutationState,
  type SettingsMutationStore,
  type SettingsSnapshot,
} from "../settingsStore.js";

/**
 * Process-wide contained-model singletons. The routes and the ambient status
 * surface share these instances so state is coherent across the API.
 */

export const downloadManager = createContainedDownloadManager();

export interface ContainedEndpointApplyDependencies {
  readonly getSnapshot: () => Promise<SettingsSnapshot>;
  readonly mutationStore: () => SettingsMutationStore;
}

interface RestoreChain {
  /** The complete pre-engine effective snapshot: the human origin/key pair. */
  original: EffectiveLlmSettings;
  /** The exact keyless engine-applied settings plus its opaque mutation token. */
  applied: SettingsMutationState;
}

/**
 * The complete in-process authority for putting the contained engine origin in
 * place and restoring the prior provider. The restore record pairs the
 * original pre-engine origin/key snapshot with the exact engine-applied
 * settings plus its opaque mutation token, so apply and restore are
 * full compare-and-swaps inside the store's serialized write queue: any
 * intervening durable write — including a same-value PATCH or an A→human→A
 * value cycle — defeats a restore instead of letting it overwrite a human
 * choice. Neither the credential, the binding, nor the token is ever exposed
 * or logged here.
 */
export function createContainedEndpointApply(dependencies: ContainedEndpointApplyDependencies) {
  let chain: RestoreChain | undefined;

  async function isEndpointEnvManaged(): Promise<boolean> {
    return (await dependencies.getSnapshot()).environmentOverrides.includes("llm_base_url");
  }

  async function applyEndpoint(engineBaseUrl: string): Promise<void> {
    const store = dependencies.mutationStore();
    // The contained loopback origin must never inherit a remote credential.
    const patch = { llmBaseUrl: engineBaseUrl, apiKey: null } as const;
    const live = await store.loadMutationState();

    if (chain) {
      if (live.token === chain.applied.token && sameEffectiveLlmSettings(live.settings, chain.applied.settings)) {
        // Replacement engine after a crash: live settings and the mutation
        // token still equal the dead engine's applied receipt, so preserve the
        // original human pair and advance only the expected applied receipt.
        const result = await store.applyIfUnchanged(chain.applied, patch);
        if (result.applied) {
          chain.applied = { settings: result.settings, token: result.token };
          return;
        }
        // Lost the settings race after the equality check. This chain did not
        // apply the replacement, so it loses all authority: a later stop must
        // never reuse the dead engine's stale expectation over a human value.
        chain = undefined;
        throw new Error("contained provider apply lost a settings race");
      }
      // A human/operator write won the race. Start a new restore chain from
      // that live origin/key pair, never from the dead engine's loopback pair.
      const result = await store.applyIfUnchanged(live, patch);
      if (!result.applied) {
        chain = undefined;
        throw new Error("contained provider apply lost a settings race");
      }
      chain = { original: live.settings, applied: { settings: result.settings, token: result.token } };
      return;
    }

    const result = await store.applyIfUnchanged(live, patch);
    if (!result.applied) throw new Error("contained provider apply lost a settings race");
    chain = { original: live.settings, applied: { settings: result.settings, token: result.token } };
  }

  async function restoreEndpoint(engineBaseUrl: string): Promise<void> {
    if (!chain) return;
    // A stop call for a different engine origin has no authority over this chain.
    if (chain.applied.settings.llmBaseUrl !== engineBaseUrl) return;
    const expected = chain;
    const store = dependencies.mutationStore();
    await store.applyIfUnchanged(expected.applied, {
      llmBaseUrl: expected.original.llmBaseUrl,
      apiKey: expected.original.apiKey ?? null,
    });
    // A successful restore clears the record; a definitive mismatch is a
    // no-op that also discards it rather than retaining a stale expectation.
    chain = undefined;
  }

  return { isEndpointEnvManaged, applyEndpoint, restoreEndpoint };
}

const endpointApply = createContainedEndpointApply({
  getSnapshot: getRuntimeSettings,
  mutationStore: runtimeSettingsMutationStore,
});

export const engineManager = createContainedEngineManager({
  isEndpointEnvManaged: endpointApply.isEndpointEnvManaged,
  applyEndpoint: endpointApply.applyEndpoint,
  restoreEndpoint: endpointApply.restoreEndpoint,
});
