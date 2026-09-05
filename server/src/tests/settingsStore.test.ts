import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSettingsStore,
  DEFAULT_LLM_SETTINGS,
  SettingsEnvironmentOverrideError,
  type SettingsFileSystem,
  SettingsValidationError,
  toPublicLlmSettings,
} from "../settingsStore.js";

const temporaryDirectories: string[] = [];

async function temporarySettingsPath(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-settings-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "settings.json");
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))
  );
});

describe("persisted LLM settings", () => {
  it("atomically writes a complete 0600 file and redacts the API key", async () => {
    const filename = await temporarySettingsPath();
    const store = createSettingsStore({ path: filename, env: {} });

    await expect(store.read()).resolves.toMatchObject({
      settings: DEFAULT_LLM_SETTINGS,
      fileStatus: "missing",
      environmentOverrides: [],
    });
    const snapshot = await store.patch({
      llmBaseUrl: "https://models.example.test",
      apiKey: "provider-secret-value",
      lmStudioBaseUrl: "http://localhost:1234",
      chatModel: "chat-model",
      embedModel: "embed-model",
    });

    expect(toPublicLlmSettings(snapshot)).toEqual({
      llm_base_url: "https://models.example.test",
      llm_api_key_configured: true,
      lm_studio_base_url: "http://localhost:1234",
      default_chat_model: "chat-model",
      default_embed_model: "embed-model",
      embedding_dimension: 768,
      managed_by_env: {
        llm_base_url: false,
        llm_api_key: false,
        lm_studio_base_url: false,
        default_chat_model: false,
        default_embed_model: false,
        embedding_dimension: false,
      },
    });
    expect(JSON.stringify(toPublicLlmSettings(snapshot))).not.toContain("provider-secret-value");

    const raw = JSON.parse(await fs.readFile(filename, "utf8"));
    expect(raw).toEqual({
      version: 3,
      llm_base_url: "https://models.example.test",
      llm_api_key: "provider-secret-value",
      llm_api_key_origin: "https://models.example.test",
      lm_studio_base_url: "http://localhost:1234",
      default_chat_model: "chat-model",
      default_embed_model: "embed-model",
      embedding_dimension: 768,
    });
    expect((await fs.stat(filename)).mode & 0o777).toBe(0o600);
    expect(await fs.readdir(path.dirname(filename))).toEqual(["settings.json"]);
  });

  it("binds an explicit key to the target origin and clears it on an unpaired origin change", async () => {
    const filename = await temporarySettingsPath();
    const store = createSettingsStore({ path: filename, env: {} });
    await store.patch({
      llmBaseUrl: "https://origin-a.example.test",
      apiKey: "origin-a-secret",
      chatModel: "chat-one",
      embedModel: "embed-one",
    });

    // A model-only patch preserves the matching pair.
    const modelOnly = await store.patch({ embedModel: "embed-two" });
    expect(modelOnly.settings.apiKey).toBe("origin-a-secret");
    expect(modelOnly.settings.apiKeyOrigin).toBe("https://origin-a.example.test");

    // A URL-only patch to a different origin clears both, durably.
    const retargeted = await store.patch({ llmBaseUrl: "https://origin-b.example.test" });
    expect(retargeted.settings.apiKey).toBeUndefined();
    expect(retargeted.settings.apiKeyOrigin).toBeUndefined();
    expect(toPublicLlmSettings(retargeted).llm_api_key_configured).toBe(false);
    const clearedFile = JSON.parse(await fs.readFile(filename, "utf8")) as Record<string, unknown>;
    expect(clearedFile).not.toHaveProperty("llm_api_key");
    expect(clearedFile).not.toHaveProperty("llm_api_key_origin");

    // Supplying URL and key together atomically binds the new pair.
    const paired = await store.patch({ llmBaseUrl: "https://origin-c.example.test", apiKey: "origin-c-secret" });
    expect(paired.settings.apiKeyOrigin).toBe("https://origin-c.example.test");
    expect(JSON.parse(await fs.readFile(filename, "utf8"))).toMatchObject({
      version: 3,
      llm_base_url: "https://origin-c.example.test",
      llm_api_key: "origin-c-secret",
      llm_api_key_origin: "https://origin-c.example.test",
    });

    // Loopback-equivalent spellings keep the binding.
    const local = await store.patch({ llmBaseUrl: "http://127.0.0.1:1234", apiKey: "local-secret" });
    expect(local.settings.apiKeyOrigin).toBe("http://127.0.0.1:1234");
    const aliased = await store.patch({ llmBaseUrl: "http://localhost:1234" });
    expect(aliased.settings.apiKey).toBe("local-secret");
    expect(aliased.settings.apiKeyOrigin).toBe("http://127.0.0.1:1234");

    // Explicit null clears the pair.
    const cleared = await store.patch({ apiKey: null });
    expect(cleared.settings.apiKey).toBeUndefined();
    expect(cleared.settings.apiKeyOrigin).toBeUndefined();
  });

  it("previews a cross-origin draft without the old origin's credential", async () => {
    const store = createSettingsStore({ path: await temporarySettingsPath(), env: {} });
    await store.patch({ llmBaseUrl: "https://origin-a.example.test", apiKey: "origin-a-preview-secret" });

    const crossOrigin = await store.preview({ llmBaseUrl: "https://origin-b.example.test" });
    expect(crossOrigin.settings.apiKey).toBeUndefined();
    const sameOrigin = await store.preview({ chatModel: "next-chat" });
    expect(sameOrigin.settings.apiKey).toBe("origin-a-preview-secret");
    const paired = await store.preview({ llmBaseUrl: "https://origin-b.example.test", apiKey: "draft-b-secret" });
    expect(paired.settings.apiKeyOrigin).toBe("https://origin-b.example.test");
  });

  it("decodes version-1 and version-2 files, preserving non-secret fields and dropping unbound keys", async () => {
    for (const version of [1, 2] as const) {
      const filename = await temporarySettingsPath();
      await fs.writeFile(
        filename,
        `${JSON.stringify({
          version,
          llm_base_url: "https://legacy.example.test",
          llm_api_key: "unbound-legacy-secret",
          lm_studio_base_url: "http://localhost:1234",
          default_chat_model: "legacy-chat",
          default_embed_model: "legacy-embed",
          ...(version === 1 ? {} : { embedding_dimension: 1024 }),
        })}\n`,
        { mode: 0o600 }
      );
      const store = createSettingsStore({ path: filename, env: {} });
      const snapshot = await store.read();

      expect(snapshot.fileStatus).toBe("loaded");
      expect(snapshot.settings).toMatchObject({
        llmBaseUrl: "https://legacy.example.test",
        lmStudioBaseUrl: "http://localhost:1234",
        chatModel: "legacy-chat",
        embedModel: "legacy-embed",
        embeddingDimension: version === 1 ? 768 : 1024,
      });
      expect(snapshot.settings.apiKey).toBeUndefined();
      expect(snapshot.settings.apiKeyOrigin).toBeUndefined();
      expect(toPublicLlmSettings(snapshot).llm_api_key_configured).toBe(false);
      expect(JSON.stringify(snapshot.settings)).not.toContain("unbound-legacy-secret");

      // The next successful patch upgrades the file to the bound version without reviving the key.
      await store.patch({ chatModel: "upgraded-chat" });
      expect(JSON.parse(await fs.readFile(filename, "utf8"))).toMatchObject({
        version: 3,
        default_chat_model: "upgraded-chat",
      });
      const raw = JSON.parse(await fs.readFile(filename, "utf8")) as Record<string, unknown>;
      expect(raw).not.toHaveProperty("llm_api_key");
    }
  });

  it("never makes a malformed or mismatched version-3 credential pair effective", async () => {
    const cases: Array<Record<string, unknown>> = [
      { llm_api_key: "half-pair-secret" },
      { llm_api_key_origin: "https://origin.example.test" },
      {
        llm_api_key: "mismatched-secret",
        llm_api_key_origin: "https://elsewhere.example.test",
      },
    ];
    for (const variant of cases) {
      const filename = await temporarySettingsPath();
      await fs.writeFile(
        filename,
        `${JSON.stringify({
          version: 3,
          llm_base_url: "https://origin.example.test",
          default_chat_model: "chat-model",
          default_embed_model: "embed-model",
          embedding_dimension: 768,
          ...variant,
        })}\n`,
        { mode: 0o600 }
      );
      const store = createSettingsStore({ path: filename, env: {} });
      const snapshot = await store.read();
      expect(snapshot.fileStatus).toBe("invalid");
      expect(snapshot.settings).toEqual(DEFAULT_LLM_SETTINGS);
      expect(JSON.stringify(snapshot.settings)).not.toMatch(/half-pair|mismatched/);
    }
  });

  it("preserves an omitted API key and clears it only with explicit null", async () => {
    const filename = await temporarySettingsPath();
    const store = createSettingsStore({ path: filename, env: {} });
    await store.patch({ apiKey: "keep-this-secret" });

    const preserved = await store.patch({ chatModel: "new-chat-model" });
    expect(preserved.settings.apiKey).toBe("keep-this-secret");
    expect((await store.preview({ embedModel: "new-embed-model" })).settings.apiKey).toBe("keep-this-secret");
    expect((JSON.parse(await fs.readFile(filename, "utf8")) as { llm_api_key?: string }).llm_api_key).toBe(
      "keep-this-secret"
    );

    const cleared = await store.patch({ apiKey: null });
    expect(cleared.settings.apiKey).toBeUndefined();
    expect(toPublicLlmSettings(cleared).llm_api_key_configured).toBe(false);
    expect(JSON.parse(await fs.readFile(filename, "utf8"))).not.toHaveProperty("llm_api_key");
  });

  it("serializes concurrent read-modify-write patches without losing fields", async () => {
    const filename = await temporarySettingsPath();
    const store = createSettingsStore({ path: filename, env: {} });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    await Promise.all([
      store.patch({ llmBaseUrl: "https://provider.example.test" }),
      store.patch({ lmStudioBaseUrl: "http://localhost:1234" }),
      store.patch({ apiKey: "concurrent-secret" }),
    ]);
    unsubscribe();

    const snapshot = await store.read();
    expect(snapshot.settings).toMatchObject({
      llmBaseUrl: "https://provider.example.test",
      lmStudioBaseUrl: "http://localhost:1234",
      apiKey: "concurrent-secret",
    });
    expect(listener).toHaveBeenCalledTimes(3);
    expect(JSON.parse(await fs.readFile(filename, "utf8"))).toMatchObject({
      llm_base_url: "https://provider.example.test",
      lm_studio_base_url: "http://localhost:1234",
      llm_api_key: "concurrent-secret",
    });
    expect(await fs.readdir(path.dirname(filename))).toEqual(["settings.json"]);
  });

  it("gives explicit environment values precedence and rejects shadowed PATCH fields", async () => {
    const filename = await temporarySettingsPath();
    const persisted = createSettingsStore({ path: filename, env: {} });
    await persisted.patch({
      llmBaseUrl: "https://stored.example.test",
      apiKey: "stored-secret",
      chatModel: "stored-chat",
      embedModel: "stored-embed",
    });

    const store = createSettingsStore({
      path: filename,
      env: {
        LLM_BASE_URL: "https://environment.example.test",
        LITELLM_BASE_URL: "https://ignored-legacy.example.test",
        LLM_API_KEY: "environment-secret",
        LITELLM_API_KEY: "ignored-legacy-secret",
        LM_STUDIO_BASE_URL: "http://localhost:1234",
        LLM_CHAT_MODEL: "environment-chat",
        LITELLM_CHAT_MODEL: "ignored-legacy-chat",
        LLM_EMBED_MODEL: "environment-embed",
        LITELLM_EMBED_MODEL: "ignored-legacy-embed",
        EMBEDDING_DIM: "1024",
      },
    });
    const snapshot = await store.read();

    expect(snapshot.settings).toEqual({
      llmBaseUrl: "https://environment.example.test",
      apiKey: "environment-secret",
      apiKeyOrigin: "https://environment.example.test",
      lmStudioBaseUrl: "http://localhost:1234",
      chatModel: "environment-chat",
      embedModel: "environment-embed",
      embeddingDimension: 1024,
    });
    expect(toPublicLlmSettings(snapshot).managed_by_env).toEqual({
      llm_base_url: true,
      llm_api_key: true,
      lm_studio_base_url: true,
      default_chat_model: true,
      default_embed_model: true,
      embedding_dimension: true,
    });
    expect(JSON.stringify(toPublicLlmSettings(snapshot))).not.toContain("environment-secret");
    await expect(store.patch({ apiKey: null })).rejects.toBeInstanceOf(SettingsEnvironmentOverrideError);
    await expect(store.patch({ embeddingDimension: 512 })).rejects.toBeInstanceOf(SettingsEnvironmentOverrideError);
    expect((await persisted.read()).settings.apiKey).toBe("stored-secret");
  });

  it("accepts legacy LiteLLM environment names as compatibility fallbacks", async () => {
    const store = createSettingsStore({
      path: await temporarySettingsPath(),
      env: {
        LITELLM_BASE_URL: "https://legacy.example.test",
        LITELLM_API_KEY: "legacy-secret",
        LITELLM_CHAT_MODEL: "legacy-chat",
        LITELLM_EMBED_MODEL: "legacy-embed",
      },
    });

    await expect(store.read()).resolves.toMatchObject({
      settings: {
        llmBaseUrl: "https://legacy.example.test",
        apiKey: "legacy-secret",
        chatModel: "legacy-chat",
        embedModel: "legacy-embed",
      },
    });
  });

  it("reads v1 files with the legacy dimension and upgrades them on the next patch", async () => {
    const filename = await temporarySettingsPath();
    await fs.writeFile(
      filename,
      `${JSON.stringify({
        version: 1,
        llm_base_url: "http://127.0.0.1:1234",
        default_chat_model: "legacy-chat",
        default_embed_model: "legacy-embed",
      })}\n`,
      { mode: 0o600 }
    );
    const store = createSettingsStore({ path: filename, env: {} });

    await expect(store.read()).resolves.toMatchObject({
      fileStatus: "loaded",
      settings: { embeddingDimension: 768 },
    });
    await store.patch({ embeddingDimension: 384 });
    expect(JSON.parse(await fs.readFile(filename, "utf8"))).toMatchObject({
      version: 3,
      embedding_dimension: 384,
    });
  });

  it("fails safe on malformed, oversized, non-regular, and semantically invalid files", async () => {
    const filename = await temporarySettingsPath();
    await fs.writeFile(filename, '{"llm_api_key":"damaged-secret",', { mode: 0o644 });
    const store = createSettingsStore({ path: filename, env: {} });

    const malformed = await store.read();
    expect(malformed.fileStatus).toBe("invalid");
    expect(malformed.settings).toEqual(DEFAULT_LLM_SETTINGS);
    expect(JSON.stringify(toPublicLlmSettings(malformed))).not.toContain("damaged-secret");
    expect((await fs.stat(filename)).mode & 0o777).toBe(0o600);

    await store.patch({ chatModel: "recovered-chat" });
    await expect(store.read()).resolves.toMatchObject({ fileStatus: "loaded" });
    expect(JSON.parse(await fs.readFile(filename, "utf8"))).toMatchObject({ default_chat_model: "recovered-chat" });

    await fs.writeFile(
      filename,
      JSON.stringify({
        version: 1,
        llm_base_url: "https://provider.example.test",
        llm_api_key: "invalid-file-secret",
        default_chat_model: "same-model",
        default_embed_model: "same-model",
      })
    );
    const invalid = await store.read();
    expect(invalid.fileStatus).toBe("invalid");
    expect(JSON.stringify(toPublicLlmSettings(invalid))).not.toContain("invalid-file-secret");

    await fs.writeFile(filename, "x".repeat(32 * 1024 + 1));
    await expect(store.read()).resolves.toMatchObject({ fileStatus: "invalid", settings: DEFAULT_LLM_SETTINGS });

    await fs.rm(filename);
    const symlinkTarget = path.join(path.dirname(filename), "outside-settings.json");
    await fs.writeFile(
      symlinkTarget,
      JSON.stringify({
        version: 1,
        llm_base_url: "https://symlink.example.test",
        llm_api_key: "symlink-secret",
        default_chat_model: "chat-model",
        default_embed_model: "embed-model",
      })
    );
    await fs.symlink(symlinkTarget, filename);
    const symlinked = await store.read();
    expect(symlinked.fileStatus).toBe("invalid");
    expect(JSON.stringify(toPublicLlmSettings(symlinked))).not.toContain("symlink-secret");

    await fs.rm(filename);
    await fs.mkdir(filename);
    await expect(store.read()).resolves.toMatchObject({ fileStatus: "invalid", settings: DEFAULT_LLM_SETTINGS });
  });

  it("clears the default on provider changes and persists an unset default across reload", async () => {
    const filename = await temporarySettingsPath();
    const store = createSettingsStore({ path: filename, env: {} });
    await store.patch({ chatModel: "old-model" });
    const next = await store.patch({ llmBaseUrl: "http://dgx01.local:4000/" });
    expect(next.settings.chatModel).toBe("");
    expect((await createSettingsStore({ path: filename, env: {} }).read()).settings.chatModel).toBe("");
    await store.patch({ chatModel: "GLM-5.3-Flash-EXL3" });
    expect((await store.patch({ llmBaseUrl: "http://dgx01.local:4000/" })).settings.chatModel).toBe(
      "GLM-5.3-Flash-EXL3"
    );
  });

  it("accepts local-network mDNS provider origins while rejecting public HTTP", async () => {
    const store = createSettingsStore({ path: await temporarySettingsPath(), env: {} });
    await store.patch({ llmBaseUrl: "http://dgx01.local:4000/" });
    expect((await store.read()).settings.llmBaseUrl).toBe("http://dgx01.local:4000");
    for (const llmBaseUrl of [
      "http://provider.example.com",
      "http://dgx01.local.example.com",
      "http://dgx01.local:4000/v1",
      "http://user:secret@dgx01.local:4000",
    ]) {
      await expect(store.patch({ llmBaseUrl })).rejects.toBeInstanceOf(SettingsValidationError);
    }
  });

  it("validates origins and distinct bounded model IDs without reflecting rejected values", async () => {
    const filename = await temporarySettingsPath();
    const store = createSettingsStore({ path: filename, env: {} });
    const unsafeUrl = "http://provider.example.test/private?token=url-secret";

    const invalidUrl = await store.patch({ llmBaseUrl: unsafeUrl }).catch((error: unknown) => error);
    expect(invalidUrl).toBeInstanceOf(SettingsValidationError);
    expect(String(invalidUrl)).not.toContain(unsafeUrl);
    await expect(store.patch({ chatModel: "nomic-embed" })).rejects.toBeInstanceOf(SettingsValidationError);
    await expect(store.patch({ chatModel: "x".repeat(257) })).rejects.toBeInstanceOf(SettingsValidationError);
    await expect(store.patch({ apiKey: "line-one\nline-two" })).rejects.toBeInstanceOf(SettingsValidationError);
    await expect(store.patch({ embeddingDimension: 0 })).rejects.toBeInstanceOf(SettingsValidationError);
    await expect(store.patch({ embeddingDimension: 16_385 })).rejects.toBeInstanceOf(SettingsValidationError);

    expect(() =>
      createSettingsStore({
        path: filename,
        env: { LLM_BASE_URL: "http://not-loopback.example.test/secret-path" },
      })
    ).toThrow("invalid settings");
  });

  it("binds an explicit environment URL and key to the environment origin", async () => {
    const filename = await temporarySettingsPath();
    const persisted = createSettingsStore({ path: filename, env: {} });
    await persisted.patch({ llmBaseUrl: "https://persisted.example.test", apiKey: "persisted-secret" });

    const store = createSettingsStore({
      path: filename,
      env: { LLM_BASE_URL: "https://environment.example.test", LLM_API_KEY: "environment-pair-secret" },
    });
    const snapshot = await store.read();
    expect(snapshot.settings).toMatchObject({
      llmBaseUrl: "https://environment.example.test",
      apiKey: "environment-pair-secret",
      apiKeyOrigin: "https://environment.example.test",
    });
    expect(JSON.stringify(toPublicLlmSettings(snapshot))).not.toContain("environment-pair-secret");
  });

  it("locks the first effective origin for a key-only environment credential", async () => {
    const filename = await temporarySettingsPath();
    const persisted = createSettingsStore({ path: filename, env: {} });
    await persisted.patch({
      llmBaseUrl: "https://first-effective.example.test",
      apiKey: "ignored-persisted-secret",
      chatModel: "persisted-chat",
      embedModel: "persisted-embed",
    });

    const store = createSettingsStore({ path: filename, env: { LLM_API_KEY: "environment-only-secret" } });
    const initial = await store.read();
    expect(initial.settings).toMatchObject({
      llmBaseUrl: "https://first-effective.example.test",
      apiKey: "environment-only-secret",
      apiKeyOrigin: "https://first-effective.example.test",
      chatModel: "persisted-chat",
    });
    const managed = toPublicLlmSettings(initial).managed_by_env;
    expect(managed.llm_base_url).toBe(true);
    expect(managed.llm_api_key).toBe(true);
    expect(JSON.stringify(toPublicLlmSettings(initial))).not.toContain("environment-only-secret");

    await expect(store.patch({ llmBaseUrl: "https://retarget.example.test" })).rejects.toBeInstanceOf(
      SettingsEnvironmentOverrideError
    );
    await expect(store.patch({ apiKey: "rejected" })).rejects.toBeInstanceOf(SettingsEnvironmentOverrideError);

    // A direct file edit cannot carry the environment key to a new origin in the same process.
    await fs.writeFile(
      filename,
      `${JSON.stringify({
        version: 3,
        llm_base_url: "https://edited-elsewhere.example.test",
        llm_api_key: "edited-persisted-secret",
        llm_api_key_origin: "https://edited-elsewhere.example.test",
        default_chat_model: "edited-chat",
        default_embed_model: "edited-embed",
        embedding_dimension: 768,
      })}\n`,
      { mode: 0o600 }
    );
    const locked = await store.read();
    expect(locked.settings).toMatchObject({
      llmBaseUrl: "https://first-effective.example.test",
      apiKey: "environment-only-secret",
      apiKeyOrigin: "https://first-effective.example.test",
    });
    expect(locked.settings.chatModel).toBe("edited-chat");
  });

  it("locks the default origin for a key-only legacy alias environment credential", async () => {
    const store = createSettingsStore({
      path: await temporarySettingsPath(),
      env: { LITELLM_API_KEY: "alias-secret" },
    });
    const snapshot = await store.read();
    expect(snapshot.settings).toMatchObject({
      llmBaseUrl: DEFAULT_LLM_SETTINGS.llmBaseUrl,
      apiKey: "alias-secret",
      apiKeyOrigin: DEFAULT_LLM_SETTINGS.llmBaseUrl,
    });
    expect(toPublicLlmSettings(snapshot).managed_by_env.llm_base_url).toBe(true);
    await expect(store.patch({ llmBaseUrl: "https://retarget.example.test" })).rejects.toBeInstanceOf(
      SettingsEnvironmentOverrideError
    );
  });

  it("treats rename as the only durable commit point with exactly one token advance", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-settings-seam-"));
    temporaryDirectories.push(directory);
    const filename = path.join(directory, "settings.json");
    const seam = createSeamFs({ widenedTemporaryMode: true });
    const store = createSettingsStore({ path: filename, env: {}, fs: seam.fs });
    await store.patch({ chatModel: "committed-chat", embedModel: "committed-embed" });
    const committed = await fs.readFile(filename, "utf8");
    const before = await store.loadMutationState();

    // A preview never advances the token.
    await store.preview({ chatModel: "preview-chat" });
    expect((await store.loadMutationState()).token).toBe(before.token);

    // Every injected pre-rename hardening failure leaves the old file and the
    // old token in place; the failure reports as a rejection, not a commit.
    for (const failing of ["mkdir", "writeFile", "chmod", "sync", "close", "rename"] as const) {
      seam.failOn = failing;
      await expect(store.patch({ chatModel: "rejected-chat" })).rejects.toThrow(failing);
      seam.failOn = undefined;
      expect(await fs.readFile(filename, "utf8")).toBe(committed);
      const unchanged = await store.loadMutationState();
      expect(unchanged.token).toBe(before.token);
      expect(unchanged.settings.chatModel).toBe("committed-chat");
    }

    // The successful rename is the commit point: new file, exactly one new
    // token, and no throwing state-changing step after the rename.
    const success = await store.patch({ chatModel: "final-chat" });
    expect(success.settings.chatModel).toBe("final-chat");
    expect((await fs.stat(filename)).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(filename, "utf8")).not.toBe(committed);
    const stale = await store.applyIfUnchanged(before, { chatModel: "stale" });
    expect(stale).toEqual({ applied: false });
    const after = await store.loadMutationState();
    expect(after.token).not.toBe(before.token);
    const current = await store.applyIfUnchanged(after, { chatModel: "final-chat" });
    expect(current.applied).toBe(true);
    expect((await store.loadMutationState()).token).not.toBe(after.token);
    const chmodIndex = seam.log.indexOf("chmod");
    const renameIndex = seam.log.indexOf("rename");
    expect(chmodIndex).toBeGreaterThanOrEqual(0);
    expect(renameIndex).toBeGreaterThanOrEqual(0);
    expect(chmodIndex).toBeLessThan(renameIndex);
    // Nothing after the final committed rename throws or mutates state.
    expect(seam.log.slice(seam.log.lastIndexOf("rename") + 1)).not.toContain("chmod");
  });

  it("advances the mutation token on every durable patch including same-value writes, never on mismatch", async () => {
    const store = createSettingsStore({ path: await temporarySettingsPath(), env: {} });
    await store.patch({ llmBaseUrl: "https://pair.example.test", apiKey: "pair-secret", chatModel: "pair-chat" });

    const snapshot = await store.loadMutationState();
    expect(snapshot.settings).toMatchObject({
      llmBaseUrl: "https://pair.example.test",
      apiKey: "pair-secret",
      apiKeyOrigin: "https://pair.example.test",
    });

    // A same-value durable write still advances the token.
    await store.patch({ chatModel: "pair-chat" });
    const stale = await store.applyIfUnchanged(snapshot, { chatModel: "overwrite" });
    expect(stale).toEqual({ applied: false });

    // A conditional apply matching the current token writes and re-tokenizes.
    const current = await store.loadMutationState();
    const applied = await store.applyIfUnchanged(current, { chatModel: "conditional-chat" });
    expect(applied.applied).toBe(true);
    if (!applied.applied) throw new Error("unreachable");
    expect(applied.before.chatModel).toBe("pair-chat");
    expect(applied.settings.chatModel).toBe("conditional-chat");
    const rerun = await store.applyIfUnchanged(current, { chatModel: "double-write" });
    expect(rerun).toEqual({ applied: false });
    // The mismatch receipt carries no settings, token, or credential detail.
    expect(Object.keys(rerun)).toEqual(["applied"]);
  });
});

type SeamStep = "mkdir" | "writeFile" | "chmod" | "sync" | "close" | "rename" | "unlink";

/**
 * Persistence seam recording the write flow and able to fail one step on
 * demand. Failures only affect the temporary-handle write path so reads and
 * directory syncing keep working between attempts.
 */
function createSeamFs(options: { widenedTemporaryMode?: boolean } = {}) {
  const log: string[] = [];
  const seam: { fs: SettingsFileSystem; log: string[]; failOn?: SeamStep } = { fs: undefined as never, log };
  const fail = (step: SeamStep) => {
    if (seam.failOn === step) throw new Error(`seam failure: ${step}`);
  };
  const wrapHandle = (handle: FileHandle, isWrite: boolean): FileHandle =>
    new Proxy(handle, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (
          isWrite &&
          typeof value === "function" &&
          ["writeFile", "chmod", "sync", "close"].includes(String(property))
        ) {
          return (...args: unknown[]) => {
            const step = String(property) as SeamStep;
            log.push(step);
            fail(step);
            return (value as (...inner: unknown[]) => unknown).apply(target, args);
          };
        }
        return value;
      },
    });
  seam.fs = {
    mkdir: async (...args: Parameters<typeof fs.mkdir>) => {
      log.push("mkdir");
      fail("mkdir");
      await fs.mkdir(...args);
    },
    open: async (target, optionsArg, modeArg) => {
      log.push("open");
      const isWrite = optionsArg === "wx";
      if (isWrite && options.widenedTemporaryMode) {
        return wrapHandle(await fs.open(target, "wx", 0o644), true);
      }
      return wrapHandle(await fs.open(target, optionsArg as string | number, modeArg), isWrite);
    },
    rename: async (...args) => {
      log.push("rename");
      fail("rename");
      return fs.rename(...args);
    },
    unlink: async (...args) => {
      log.push("unlink");
      fail("unlink");
      return fs.unlink(...args);
    },
  };
  return seam;
}
