import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeRuntimeSettings,
  getEffectiveLlmSettings,
  getRuntimeSettings,
  initializeRuntimeSettings,
  runtimeSettingsStore,
} from "../runtimeSettings.js";

const temporaryDirectories: string[] = [];

async function temporarySettingsFile(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-runtime-settings-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "settings.json");
}

afterEach(async () => {
  closeRuntimeSettings();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))
  );
});

describe("runtime settings singleton", () => {
  it("publishes immutable revisioned snapshots and hot-updates after a durable PATCH", async () => {
    const settingsFile = await temporarySettingsFile();
    const initial = await initializeRuntimeSettings({ settingsFile, env: {} });

    expect(initial.settings).toMatchObject({
      llmBaseUrl: "http://127.0.0.1:1234",
      chatModel: "qwen-chat",
      embedModel: "nomic-embed",
    });
    expect(Object.isFrozen(initial)).toBe(true);
    expect(Object.isFrozen(initial.settings)).toBe(true);

    await runtimeSettingsStore().patch({
      llmBaseUrl: "https://provider.example.test",
      apiKey: "runtime-secret",
      chatModel: "runtime-chat",
      embedModel: "runtime-embed",
    });
    const updated = await getRuntimeSettings();
    expect(updated.revision).toBeGreaterThan(initial.revision);
    expect(updated.settings).toEqual({
      llmBaseUrl: "https://provider.example.test",
      apiKey: "runtime-secret",
      chatModel: "runtime-chat",
      embedModel: "runtime-embed",
    });
    await expect(getEffectiveLlmSettings()).resolves.toEqual(updated.settings);

    await runtimeSettingsStore().patch({ chatModel: "runtime-chat" });
    expect((await getRuntimeSettings()).revision).toBe(updated.revision);
  });

  it("applies environment overrides to both initial and patched snapshots", async () => {
    const settingsFile = await temporarySettingsFile();
    const initial = await initializeRuntimeSettings({
      settingsFile,
      env: {
        LLM_BASE_URL: "https://environment.example.test",
        LLM_API_KEY: "environment-secret",
        LLM_CHAT_MODEL: "environment-chat",
      },
    });

    expect(initial.settings).toMatchObject({
      llmBaseUrl: "https://environment.example.test",
      apiKey: "environment-secret",
      chatModel: "environment-chat",
    });
    expect(initial.environmentOverrides).toEqual(["llm_base_url", "llm_api_key", "default_chat_model"]);

    await runtimeSettingsStore().patch({ embedModel: "persisted-embed" });
    const updated = await getRuntimeSettings();
    expect(updated.settings).toMatchObject({
      llmBaseUrl: "https://environment.example.test",
      apiKey: "environment-secret",
      chatModel: "environment-chat",
      embedModel: "persisted-embed",
    });
    await expect(runtimeSettingsStore().patch({ llmBaseUrl: "https://ignored.example.test" })).rejects.toThrow(
      "managed by environment"
    );
  });

  it("coalesces initialization and rejects a second storage identity", async () => {
    const settingsFile = await temporarySettingsFile();
    const [first, second] = await Promise.all([
      initializeRuntimeSettings({ settingsFile, env: {} }),
      initializeRuntimeSettings({ settingsFile, env: {} }),
    ]);
    expect(first).toBe(second);

    const other = await temporarySettingsFile();
    await expect(initializeRuntimeSettings({ settingsFile: other, env: {} })).rejects.toThrow(
      "runtime settings are already initialized"
    );
  });
});
