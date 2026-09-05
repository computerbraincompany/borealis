import http, { type Server } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createContainedEndpointApply } from "../contained/runtime.js";
import { probeSettingsConnection } from "../routes/settings.js";
import { createSettingsStore, type SettingsMutationStore } from "../settingsStore.js";

const temporaryDirectories: string[] = [];
const servers: Server[] = [];

async function temporaryStore(env: Readonly<Record<string, string | undefined>> = {}): Promise<SettingsMutationStore> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-contained-runtime-"));
  temporaryDirectories.push(directory);
  return createSettingsStore({ path: path.join(directory, "settings.json"), env });
}

/** Loopback fixture provider that records every Authorization header it receives. */
async function startRecorder(requireToken?: string): Promise<{
  readonly origin: string;
  readonly seen: Array<string | undefined>;
}> {
  const seen: Array<string | undefined> = [];
  const server = http.createServer((request, response) => {
    seen.push(request.headers.authorization);
    if (requireToken !== undefined && request.headers.authorization !== `Bearer ${requireToken}`) {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end('{"error":"denied"}');
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end('{"data":[]}');
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind a TCP address");
  return { origin: `http://127.0.0.1:${address.port}`, seen };
}

function factoryFor(store: SettingsMutationStore) {
  return createContainedEndpointApply({
    getSnapshot: () => store.read(),
    mutationStore: () => store,
  });
}

/** Probe the current effective settings exactly like the ambient status surface would. */
async function probeEffective(store: SettingsMutationStore) {
  const snapshot = await store.read();
  return probeSettingsConnection(snapshot.settings);
}

async function seedRemoteProvider(store: SettingsMutationStore, origin: string, key = "restore-owner-key") {
  await store.patch({
    llmBaseUrl: origin,
    apiKey: key,
    chatModel: "owner-chat",
    embedModel: "owner-embed",
  });
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        })
    )
  );
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))
  );
});

describe("contained endpoint apply and restore", () => {
  it("switches to a keyless loopback engine and restores the original origin with its header", async () => {
    const remote = await startRecorder("restore-owner-key");
    const engine = await startRecorder();
    const store = await temporaryStore();
    await seedRemoteProvider(store, remote.origin);
    const apply = factoryFor(store);

    await apply.applyEndpoint(engine.origin);
    const applied = await store.read();
    // The engine-origin switch clears the default chat model (existing
    // provider-change behavior) and detaches the credential pair.
    expect(applied.settings).toMatchObject({
      llmBaseUrl: engine.origin,
      chatModel: "",
      embedModel: "owner-embed",
    });
    expect(applied.settings.apiKey).toBeUndefined();
    expect(applied.settings.apiKeyOrigin).toBeUndefined();
    expect(remote.seen).toEqual([]);

    // The contained origin is genuinely keyless on the wire.
    expect((await probeEffective(store)).ok).toBe(true);
    expect(engine.seen).toEqual([undefined]);

    await apply.restoreEndpoint(engine.origin);
    const restored = await store.read();
    expect(restored.settings.llmBaseUrl).toBe(remote.origin);
    expect(restored.settings.apiKey).toBe("restore-owner-key");
    expect(restored.settings.apiKeyOrigin).toBe(remote.origin);
    expect((await probeEffective(store)).ok).toBe(true);
    expect(remote.seen.at(-1)).toBe("Bearer restore-owner-key");

    // A second stop has no authority after the successful restore cleared the chain.
    await apply.restoreEndpoint(engine.origin);
    expect((await store.read()).settings.llmBaseUrl).toBe(remote.origin);
  });

  it("leaves an intervening durable write untouched instead of restoring", async () => {
    interface InterveningCase {
      readonly name: string;
      readonly patch: (humanOrigin: string) => Promise<Record<string, unknown>>;
      readonly expectedOrigin: "human" | "engine";
      readonly expectedKey?: string;
    }
    const cases: InterveningCase[] = [
      {
        name: "endpoint",
        patch: async (humanOrigin) => ({ llmBaseUrl: humanOrigin, apiKey: "human-endpoint-key" }),
        expectedOrigin: "human",
        expectedKey: "human-endpoint-key",
      },
      {
        name: "same-origin key",
        patch: async () => ({ apiKey: "human-loopback-key" }),
        expectedOrigin: "engine",
        expectedKey: "human-loopback-key",
      },
      { name: "model", patch: async () => ({ embedModel: "watched-embed" }), expectedOrigin: "engine" },
      {
        name: "health endpoint",
        patch: async (humanOrigin) => ({ lmStudioBaseUrl: humanOrigin }),
        expectedOrigin: "engine",
      },
    ];

    for (const testCase of cases) {
      const remote = await startRecorder("restore-owner-key");
      const engine = await startRecorder();
      const human = await startRecorder("human-endpoint-key");
      const store = await temporaryStore();
      await seedRemoteProvider(store, remote.origin);
      const apply = factoryFor(store);

      await apply.applyEndpoint(engine.origin);
      await store.patch(await testCase.patch(human.origin));
      const before = await store.read();
      await apply.restoreEndpoint(engine.origin);
      const after = await store.read();

      // The human write survived; the restore was a no-op.
      expect(after.settings, testCase.name).toEqual(before.settings);
      expect(after.settings.llmBaseUrl, testCase.name).toBe(
        testCase.expectedOrigin === "human" ? human.origin : engine.origin
      );
      if (testCase.expectedKey !== undefined) {
        expect(after.settings.apiKey, testCase.name).toBe(testCase.expectedKey);
      }
    }
  });

  it("defeats the restore on a same-value PATCH and on an A→human→A value cycle", async () => {
    const remote = await startRecorder("restore-owner-key");
    const engine = await startRecorder();
    const human = await startRecorder();
    const store = await temporaryStore();
    await seedRemoteProvider(store, remote.origin);
    const apply = factoryFor(store);

    await apply.applyEndpoint(engine.origin);
    const applied = (await store.read()).settings;

    // Same-value durable PATCH while the engine is active: values identical,
    // token advanced, so restore must not run.
    await store.patch({
      llmBaseUrl: applied.llmBaseUrl,
      apiKey: null,
      lmStudioBaseUrl: applied.lmStudioBaseUrl ?? null,
      chatModel: applied.chatModel,
      embedModel: applied.embedModel,
      embeddingDimension: applied.embeddingDimension,
    });
    await apply.restoreEndpoint(engine.origin);
    expect((await store.read()).settings).toEqual(applied);

    // A→human→A: values deliberately equal the applied snapshot again, but the
    // opaque token differs, so the restore must remain a no-op.
    await store.patch({ llmBaseUrl: human.origin, apiKey: null });
    await store.patch({
      llmBaseUrl: applied.llmBaseUrl,
      apiKey: null,
      lmStudioBaseUrl: applied.lmStudioBaseUrl ?? null,
      chatModel: applied.chatModel,
      embedModel: applied.embedModel,
      embeddingDimension: applied.embeddingDimension,
    });
    await apply.restoreEndpoint(engine.origin);
    const cycled = await store.read();
    expect(cycled.settings).toEqual(applied);
    expect(cycled.settings.apiKey).toBeUndefined();
    expect(remote.seen).toEqual([]);
  });

  it("cannot overwrite a write queued between the restore request and the store critical section", async () => {
    const remote = await startRecorder("restore-owner-key");
    const engine = await startRecorder();
    const human = await startRecorder("queued-human-key");
    const real = await temporaryStore();
    await seedRemoteProvider(real, remote.origin);

    let flushHuman = false;
    const wrapped: SettingsMutationStore = {
      read: () => real.read(),
      patch: (patch) => real.patch(patch),
      preview: (patch) => real.preview(patch),
      subscribe: (listener) => real.subscribe(listener),
      loadMutationState: () => real.loadMutationState(),
      applyIfUnchanged: async (expected, patch) => {
        if (flushHuman) {
          flushHuman = false;
          // The intervening human write lands in the queue after the restore
          // was requested but before its conditional critical section runs.
          await real.patch({ llmBaseUrl: human.origin, apiKey: "queued-human-key" });
        }
        return real.applyIfUnchanged(expected, patch);
      },
    };
    const apply = factoryFor(wrapped);
    await apply.applyEndpoint(engine.origin);

    flushHuman = true;
    await apply.restoreEndpoint(engine.origin);
    const final = (await real.read()).settings;
    expect(final.llmBaseUrl).toBe(human.origin);
    expect(final.apiKey).toBe("queued-human-key");

    // The discarded chain cannot restore R afterwards either.
    await apply.restoreEndpoint(engine.origin);
    expect((await real.read()).settings.llmBaseUrl).toBe(human.origin);
  });

  it("restores the first human provider across a crash/reapply chain, never the dead engine", async () => {
    const remote = await startRecorder("restore-owner-key");
    const engineA = await startRecorder();
    const engineB = await startRecorder();
    const store = await temporaryStore();
    await seedRemoteProvider(store, remote.origin);
    const apply = factoryFor(store);

    await apply.applyEndpoint(engineA.origin);
    // Engine A crashes without stop ever running for it.
    await apply.applyEndpoint(engineB.origin);
    expect((await store.read()).settings.llmBaseUrl).toBe(engineB.origin);

    await apply.restoreEndpoint(engineB.origin);
    const restored = await store.read();
    expect(restored.settings.llmBaseUrl).toBe(remote.origin);
    expect(restored.settings.apiKey).toBe("restore-owner-key");
    expect((await probeEffective(store)).ok).toBe(true);
    expect(remote.seen.at(-1)).toBe("Bearer restore-owner-key");
    // The dead engines never received a credential.
    expect(engineA.seen.every((header) => header === undefined)).toBe(true);
    expect(engineB.seen.every((header) => header === undefined)).toBe(true);
  });

  it("starts a new restore chain from a human pair that replaced the dead engine", async () => {
    const remote = await startRecorder("restore-owner-key");
    const engineA = await startRecorder();
    const engineB = await startRecorder();
    const human = await startRecorder("human-pair-key");
    const store = await temporaryStore();
    await seedRemoteProvider(store, remote.origin);
    const apply = factoryFor(store);

    await apply.applyEndpoint(engineA.origin);
    // A human/operator write lands after A crashes and before B applies.
    await store.patch({ llmBaseUrl: human.origin, apiKey: "human-pair-key" });
    await apply.applyEndpoint(engineB.origin);
    await apply.restoreEndpoint(engineB.origin);

    const restored = await store.read();
    expect(restored.settings.llmBaseUrl).toBe(human.origin);
    expect(restored.settings.apiKey).toBe("human-pair-key");
    expect((await probeEffective(store)).ok).toBe(true);
    expect(remote.seen).toEqual([]);
    expect(human.seen).toEqual(["Bearer human-pair-key"]);
  });

  it("clears the whole restore chain when the conditional replacement apply loses a race", async () => {
    const remote = await startRecorder("restore-owner-key");
    const engineA = await startRecorder();
    const engineB = await startRecorder();
    const human = await startRecorder();
    const real = await temporaryStore();
    await seedRemoteProvider(real, remote.origin);

    let flushHuman = false;
    const wrapped: SettingsMutationStore = {
      read: () => real.read(),
      patch: (patch) => real.patch(patch),
      preview: (patch) => real.preview(patch),
      subscribe: (listener) => real.subscribe(listener),
      loadMutationState: () => real.loadMutationState(),
      applyIfUnchanged: async (expected, patch) => {
        if (flushHuman) {
          flushHuman = false;
          await real.patch({ llmBaseUrl: human.origin, apiKey: null });
        }
        return real.applyIfUnchanged(expected, patch);
      },
    };
    const apply = factoryFor(wrapped);
    await apply.applyEndpoint(engineA.origin);
    const deadAppliedSnapshot = await real.read();

    flushHuman = true;
    await expect(apply.applyEndpoint(engineB.origin)).rejects.toThrow("settings race");
    // B was never applied through this chain; the old chain is cleared.
    expect((await real.read()).settings.llmBaseUrl).toBe(human.origin);

    // A human writes complete effective values deliberately equal to the dead
    // engine A's applied snapshot; a later stop must leave it untouched and
    // must not restore R.
    const dead = deadAppliedSnapshot.settings;
    await real.patch({
      llmBaseUrl: dead.llmBaseUrl,
      apiKey: null,
      lmStudioBaseUrl: dead.lmStudioBaseUrl ?? null,
      chatModel: dead.chatModel,
      embedModel: dead.embedModel,
      embeddingDimension: dead.embeddingDimension,
    });
    await apply.restoreEndpoint(engineB.origin);
    expect((await real.read()).settings).toEqual(dead);
    expect(remote.seen).toEqual([]);
  });

  it("reports the endpoint as environment-managed for explicit and key-only environment credentials", async () => {
    const explicit = factoryFor(await temporaryStore({ LLM_BASE_URL: "http://127.0.0.1:1234" }));
    expect(await explicit.isEndpointEnvManaged()).toBe(true);

    const keyOnly = factoryFor(await temporaryStore({ LLM_API_KEY: "environment-only-key" }));
    expect(await keyOnly.isEndpointEnvManaged()).toBe(true);

    const unmanaged = factoryFor(await temporaryStore());
    expect(await unmanaged.isEndpointEnvManaged()).toBe(false);
  });
});
