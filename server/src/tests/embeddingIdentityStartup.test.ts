import { describe, expect, it } from "vitest";

import { DEFAULT_LLM_SETTINGS, type SettingsSnapshot } from "../settingsStore.js";
import { mayAdoptLegacyEmbeddingIdentity } from "../storageRuntime.js";

function snapshot(
  fileStatus: SettingsSnapshot["fileStatus"],
  overrides: SettingsSnapshot["environmentOverrides"] = [],
  embedModel = DEFAULT_LLM_SETTINGS.embedModel,
  embeddingDimension = DEFAULT_LLM_SETTINGS.embeddingDimension
): SettingsSnapshot {
  return {
    settings: { ...DEFAULT_LLM_SETTINGS, embedModel, embeddingDimension },
    environmentOverrides: overrides,
    fileStatus,
  };
}

describe("legacy embedding identity adoption policy", () => {
  it("allows a loaded durable identity and the pinned markerless default", () => {
    expect(mayAdoptLegacyEmbeddingIdentity(snapshot("loaded", [], "persisted-model", 384))).toBe(true);
    expect(mayAdoptLegacyEmbeddingIdentity(snapshot("missing"))).toBe(true);
  });

  it("fails closed for environment-managed, invalid, or non-default missing identities", () => {
    expect(mayAdoptLegacyEmbeddingIdentity(snapshot("loaded", ["default_embed_model"]))).toBe(false);
    expect(mayAdoptLegacyEmbeddingIdentity(snapshot("loaded", ["embedding_dimension"]))).toBe(false);
    expect(mayAdoptLegacyEmbeddingIdentity(snapshot("invalid"))).toBe(false);
    expect(mayAdoptLegacyEmbeddingIdentity(snapshot("missing", [], "edited-model", 768))).toBe(false);
    expect(mayAdoptLegacyEmbeddingIdentity(snapshot("missing", [], "nomic-embed", 384))).toBe(false);
  });
});
