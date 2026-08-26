import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSettingsStore,
  DEFAULT_LLM_SETTINGS,
  SettingsEnvironmentOverrideError,
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
      managed_by_env: {
        llm_base_url: false,
        llm_api_key: false,
        lm_studio_base_url: false,
        default_chat_model: false,
        default_embed_model: false,
      },
    });
    expect(JSON.stringify(toPublicLlmSettings(snapshot))).not.toContain("provider-secret-value");

    const raw = JSON.parse(await fs.readFile(filename, "utf8"));
    expect(raw).toEqual({
      version: 1,
      llm_base_url: "https://models.example.test",
      llm_api_key: "provider-secret-value",
      lm_studio_base_url: "http://localhost:1234",
      default_chat_model: "chat-model",
      default_embed_model: "embed-model",
    });
    expect((await fs.stat(filename)).mode & 0o777).toBe(0o600);
    expect(await fs.readdir(path.dirname(filename))).toEqual(["settings.json"]);
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
      },
    });
    const snapshot = await store.read();

    expect(snapshot.settings).toEqual({
      llmBaseUrl: "https://environment.example.test",
      apiKey: "environment-secret",
      lmStudioBaseUrl: "http://localhost:1234",
      chatModel: "environment-chat",
      embedModel: "environment-embed",
    });
    expect(toPublicLlmSettings(snapshot).managed_by_env).toEqual({
      llm_base_url: true,
      llm_api_key: true,
      lm_studio_base_url: true,
      default_chat_model: true,
      default_embed_model: true,
    });
    expect(JSON.stringify(toPublicLlmSettings(snapshot))).not.toContain("environment-secret");
    await expect(store.patch({ apiKey: null })).rejects.toBeInstanceOf(SettingsEnvironmentOverrideError);
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

    expect(() =>
      createSettingsStore({
        path: filename,
        env: { LLM_BASE_URL: "http://not-loopback.example.test/secret-path" },
      })
    ).toThrow("invalid settings");
  });
});
