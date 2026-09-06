import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fsPromises from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { sameLlmModel } from "./llmAliases.js";

export const SETTINGS_FILE_VERSION = 3 as const;
const PRE_DIMENSION_FILE_VERSION = 1 as const;
const UNBOUND_CREDENTIAL_FILE_VERSION = 2 as const;
export const DEFAULT_EMBEDDING_DIMENSION = 768;
export const DEFAULT_LLM_SETTINGS = Object.freeze({
  llmBaseUrl: "http://127.0.0.1:1234",
  chatModel: "qwen-chat",
  embedModel: "nomic-embed",
  embeddingDimension: DEFAULT_EMBEDDING_DIMENSION,
} satisfies EffectiveLlmSettings);

const MAX_SETTINGS_FILE_BYTES = 32 * 1024;
export const MAX_ENDPOINT_CHARS = 2_048;
export const MAX_API_KEY_CHARS = 8_192;
export const MODEL_ID_MAX_CHARS = 256;
const MAX_EMBEDDING_DIMENSION = 16_384;

export type LlmSettingField =
  | "llm_base_url"
  | "llm_api_key"
  | "lm_studio_base_url"
  | "default_chat_model"
  | "default_embed_model"
  | "embedding_dimension";

export interface EffectiveLlmSettings {
  readonly llmBaseUrl: string;
  readonly apiKey?: string;
  /**
   * Canonical origin a saved credential is bound to. It is only ever present
   * beside `apiKey` and equivalent to `llmBaseUrl`. It is internal: public
   * snapshots expose neither the credential nor this binding.
   */
  readonly apiKeyOrigin?: string;
  readonly lmStudioBaseUrl?: string;
  readonly chatModel: string;
  readonly embedModel: string;
  readonly embeddingDimension: number;
}

export interface LlmSettingsPatch {
  readonly llmBaseUrl?: string;
  readonly apiKey?: string | null;
  readonly lmStudioBaseUrl?: string | null;
  readonly chatModel?: string;
  readonly embedModel?: string;
  readonly embeddingDimension?: number;
}

export interface SettingsSnapshot {
  readonly settings: EffectiveLlmSettings;
  readonly environmentOverrides: readonly LlmSettingField[];
  readonly fileStatus: "loaded" | "missing" | "invalid";
}

export interface PublicLlmSettings {
  readonly llm_base_url: string;
  readonly llm_api_key_configured: boolean;
  readonly lm_studio_base_url: string | null;
  readonly default_chat_model: string;
  readonly default_embed_model: string;
  readonly embedding_dimension: number;
  readonly managed_by_env: Readonly<Record<LlmSettingField, boolean>>;
}

export interface SettingsStore {
  read(): Promise<SettingsSnapshot>;
  patch(patch: LlmSettingsPatch): Promise<SettingsSnapshot>;
  preview(patch: LlmSettingsPatch): Promise<SettingsSnapshot>;
  subscribe(listener: (snapshot: SettingsSnapshot) => void): () => void;
}

declare const settingsMutationTokenBrand: unique symbol;

/**
 * Opaque process-local mutation identity advanced by every successful durable
 * write. It is never persisted, serialized, returned in a public snapshot, or
 * logged; identity comparison is its only operation.
 */
export interface SettingsMutationToken {
  readonly [settingsMutationTokenBrand]: never;
}

/** Internal write-queue receipt pairing effective state with its mutation token. */
export interface SettingsMutationState {
  readonly settings: EffectiveLlmSettings;
  readonly token: SettingsMutationToken;
}

export interface SettingsApplyReceipt extends SettingsMutationState {
  readonly applied: true;
  readonly before: EffectiveLlmSettings;
}

export interface SettingsApplyMismatch {
  readonly applied: false;
}

export type SettingsApplyResult = SettingsApplyReceipt | SettingsApplyMismatch;

/**
 * Internal conditional-apply surface used only by in-process consumers that
 * need a single critical-section compare-and-patch (contained endpoint apply).
 * It never appears in public responses; mismatches carry no settings, token,
 * or credential detail.
 */
export interface SettingsMutationStore extends SettingsStore {
  loadMutationState(): Promise<SettingsMutationState>;
  applyIfUnchanged(expected: SettingsMutationState, patch: LlmSettingsPatch): Promise<SettingsApplyResult>;
}

export type SettingsFileSystem = Pick<typeof fsPromises, "mkdir" | "open" | "rename" | "unlink">;

export interface CreateSettingsStoreOptions {
  readonly path: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Test-only persistence seam; production always uses `node:fs/promises`. */
  readonly fs?: SettingsFileSystem;
}

interface PersistedSettingsFile {
  readonly version: typeof SETTINGS_FILE_VERSION;
  readonly llm_base_url: string;
  readonly llm_api_key?: string;
  readonly llm_api_key_origin?: string;
  readonly lm_studio_base_url?: string;
  readonly default_chat_model: string;
  readonly default_embed_model: string;
  readonly embedding_dimension: number;
}

interface PersistedRead {
  readonly settings: EffectiveLlmSettings;
  readonly status: SettingsSnapshot["fileStatus"];
}

interface MutableEffectiveLlmSettings {
  llmBaseUrl?: string;
  apiKey?: string;
  apiKeyOrigin?: string;
  lmStudioBaseUrl?: string;
  chatModel?: string;
  embedModel?: string;
  embeddingDimension?: number;
}

type MutableCompleteLlmSettings = { -readonly [K in keyof EffectiveLlmSettings]: EffectiveLlmSettings[K] };

interface EnvironmentSettings {
  readonly values: MutableEffectiveLlmSettings;
  readonly fields: readonly LlmSettingField[];
  /** An environment API key without an environment base URL locks one origin for the process. */
  readonly keyOnly: boolean;
}

export class SettingsValidationError extends Error {
  readonly code = "INVALID_SETTINGS";

  constructor(readonly field?: LlmSettingField) {
    super("invalid settings");
    this.name = "SettingsValidationError";
  }
}

export class SettingsEnvironmentOverrideError extends Error {
  readonly code = "SETTINGS_ENVIRONMENT_OVERRIDE";

  constructor(readonly field: LlmSettingField) {
    super("setting is managed by environment");
    this.name = "SettingsEnvironmentOverrideError";
  }
}

/**
 * Create the settings persistence boundary used by both the HTTP API and hot
 * model-client reconfiguration. Reads never expose parse or filesystem errors;
 * a damaged file falls back to local-safe defaults until a valid PATCH replaces it.
 */
export function createSettingsStore(options: CreateSettingsStoreOptions): SettingsMutationStore {
  return new FileSettingsStore(options);
}

export function toPublicLlmSettings(snapshot: SettingsSnapshot): PublicLlmSettings {
  const managed = new Set(snapshot.environmentOverrides);
  return {
    llm_base_url: snapshot.settings.llmBaseUrl,
    llm_api_key_configured: Boolean(snapshot.settings.apiKey),
    lm_studio_base_url: snapshot.settings.lmStudioBaseUrl ?? null,
    default_chat_model: snapshot.settings.chatModel,
    default_embed_model: snapshot.settings.embedModel,
    embedding_dimension: snapshot.settings.embeddingDimension,
    managed_by_env: {
      llm_base_url: managed.has("llm_base_url"),
      llm_api_key: managed.has("llm_api_key"),
      lm_studio_base_url: managed.has("lm_studio_base_url"),
      default_chat_model: managed.has("default_chat_model"),
      default_embed_model: managed.has("default_embed_model"),
      embedding_dimension: managed.has("embedding_dimension"),
    },
  };
}

/**
 * The canonical, credential-free bare provider origin (Plan 005 parser): the
 * exact `URL.origin` form, bounded by the Settings endpoint ceiling. It is the
 * only representation durable consent may persist or compare. Never call it
 * with credential- or payload-bearing input, and never log its failures.
 */
export function canonicalizeProviderOrigin(value: string): string {
  return parseEndpointOrigin(value, "llm_base_url");
}

/** Compare loopback spellings without DNS, so localhost and 127.0.0.1 deduplicate. */
export function modelEndpointOriginsEquivalent(left: string, right: string): boolean {
  const leftUrl = new URL(left);
  const rightUrl = new URL(right);
  if (leftUrl.origin === rightUrl.origin) return true;
  return (
    leftUrl.protocol === rightUrl.protocol &&
    effectivePort(leftUrl) === effectivePort(rightUrl) &&
    isLoopbackHostname(leftUrl.hostname) &&
    isLoopbackHostname(rightUrl.hostname)
  );
}

/** Complete effective-field equality, including the credential and its binding. */
export function sameEffectiveLlmSettings(left: EffectiveLlmSettings, right: EffectiveLlmSettings): boolean {
  return (
    left.llmBaseUrl === right.llmBaseUrl &&
    left.apiKey === right.apiKey &&
    left.apiKeyOrigin === right.apiKeyOrigin &&
    left.lmStudioBaseUrl === right.lmStudioBaseUrl &&
    left.chatModel === right.chatModel &&
    left.embedModel === right.embedModel &&
    left.embeddingDimension === right.embeddingDimension
  );
}

function createSettingsMutationToken(): SettingsMutationToken {
  return Object.freeze({}) as SettingsMutationToken;
}

class FileSettingsStore implements SettingsMutationStore {
  readonly #filename: string;
  readonly #environment: EnvironmentSettings;
  readonly #fs: SettingsFileSystem;
  readonly #listeners = new Set<(snapshot: SettingsSnapshot) => void>();
  #writeTail: Promise<void> = Promise.resolve();
  #mutationToken: SettingsMutationToken = createSettingsMutationToken();
  #environmentKeyOrigin?: string;

  constructor(options: CreateSettingsStoreOptions) {
    this.#filename = path.resolve(options.path);
    this.#environment = resolveEnvironmentSettings(options.env ?? process.env);
    this.#fs = options.fs ?? fsPromises;
  }

  async read(): Promise<SettingsSnapshot> {
    return this.#serialize(async () => this.#snapshot(await this.#readPersisted()));
  }

  patch(patch: LlmSettingsPatch): Promise<SettingsSnapshot> {
    return this.#serialize(async () => {
      const result = await this.#applyPatchCritical(patch);
      this.#publish(result.snapshot);
      return result.snapshot;
    });
  }

  preview(patch: LlmSettingsPatch): Promise<SettingsSnapshot> {
    return this.#serialize(async () => {
      this.#assertPatchable(patch);
      const persisted = await this.#readPersisted();
      return this.#snapshot({ settings: applyPatch(persisted.settings, patch), status: persisted.status });
    });
  }

  loadMutationState(): Promise<SettingsMutationState> {
    return this.#serialize(async () => ({
      settings: this.#snapshot(await this.#readPersisted()).settings,
      token: this.#mutationToken,
    }));
  }

  applyIfUnchanged(expected: SettingsMutationState, patch: LlmSettingsPatch): Promise<SettingsApplyResult> {
    return this.#serialize(async () => {
      const current = this.#snapshot(await this.#readPersisted());
      if (this.#mutationToken !== expected.token || !sameEffectiveLlmSettings(current.settings, expected.settings)) {
        return { applied: false };
      }
      const result = await this.#applyPatchCritical(patch);
      this.#publish(result.snapshot);
      return {
        applied: true,
        before: result.before,
        settings: result.snapshot.settings,
        token: this.#mutationToken,
      };
    });
  }

  subscribe(listener: (snapshot: SettingsSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#writeTail.then(operation, operation);
    this.#writeTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  /** Durable write inside an already-serialized critical section. */
  async #applyPatchCritical(
    patch: LlmSettingsPatch
  ): Promise<{ before: EffectiveLlmSettings; snapshot: SettingsSnapshot }> {
    this.#assertPatchable(patch);
    const persisted = await this.#readPersisted();
    const before = this.#snapshot({ settings: persisted.settings, status: persisted.status }).settings;
    const settings = applyPatch(persisted.settings, patch);
    await writeSettingsFileAtomically(this.#filename, settings, this.#fs);
    // The rename above is the sole durable commit point. Advancing the token
    // and publishing the receipt happens only after it succeeds; a failed or
    // rejected write never changes the file, the token, or the listeners.
    this.#mutationToken = createSettingsMutationToken();
    return { before, snapshot: this.#snapshot({ settings, status: "loaded" }) };
  }

  #publish(snapshot: SettingsSnapshot): void {
    for (const listener of this.#listeners) {
      try {
        listener(snapshot);
      } catch {
        // A model-client subscriber cannot roll back an already durable file.
      }
    }
  }

  #assertPatchable(patch: LlmSettingsPatch): void {
    const patchedFields = patchFields(patch);
    for (const field of this.#environment.fields) {
      if (patchedFields.has(field)) throw new SettingsEnvironmentOverrideError(field);
    }
  }

  #snapshot(persisted: PersistedRead): SettingsSnapshot {
    const environment = this.#environment;
    // Environment values win over the persisted record. An environment-owned
    // credential field (present with `undefined` after an empty override)
    // therefore also clears any persisted key/binding pair via the spread.
    const merged: MutableCompleteLlmSettings = { ...persisted.settings, ...environment.values };
    if (environment.fields.includes("llm_api_key")) {
      // The environment owns the credential: a persisted pair never rides
      // along, and a key-only environment binds one locked origin per process.
      merged.apiKey = environment.values.apiKey;
      if (environment.keyOnly) {
        if (merged.apiKey === undefined) {
          merged.apiKeyOrigin = undefined;
        } else {
          this.#environmentKeyOrigin ??= parseEndpointOrigin(merged.llmBaseUrl, "llm_base_url");
          merged.llmBaseUrl = this.#environmentKeyOrigin;
          merged.apiKeyOrigin = this.#environmentKeyOrigin;
        }
      } else {
        merged.apiKeyOrigin = merged.apiKey === undefined ? undefined : environment.values.llmBaseUrl;
      }
    }
    const settings = validateCompleteSettings(merged);
    return Object.freeze({
      settings: Object.freeze(settings),
      environmentOverrides: environment.fields,
      fileStatus: persisted.status,
    });
  }

  async #readPersisted(): Promise<PersistedRead> {
    let handle: Awaited<ReturnType<typeof fsPromises.open>> | undefined;
    try {
      handle = await this.#fs.open(this.#filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_SETTINGS_FILE_BYTES) {
        return { settings: DEFAULT_LLM_SETTINGS, status: "invalid" };
      }
      if ((stat.mode & 0o777) !== 0o600) await handle.chmod(0o600);
      const contents = await handle.readFile("utf8");
      if (Buffer.byteLength(contents, "utf8") > MAX_SETTINGS_FILE_BYTES) {
        return { settings: DEFAULT_LLM_SETTINGS, status: "invalid" };
      }
      return { settings: decodeSettingsFile(JSON.parse(contents)), status: "loaded" };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { settings: DEFAULT_LLM_SETTINGS, status: "missing" };
      }
      return { settings: DEFAULT_LLM_SETTINGS, status: "invalid" };
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}

function resolveEnvironmentSettings(env: Readonly<Record<string, string | undefined>>): EnvironmentSettings {
  const values: MutableEffectiveLlmSettings = {};
  const fields: LlmSettingField[] = [];

  const baseUrlName = env.LLM_BASE_URL !== undefined ? "LLM_BASE_URL" : "LITELLM_BASE_URL";
  const baseUrl = env[baseUrlName];
  if (baseUrl !== undefined) {
    values.llmBaseUrl = parseEndpointOrigin(baseUrl, "llm_base_url");
    fields.push("llm_base_url");
  }
  const apiKey = env.LLM_API_KEY !== undefined ? env.LLM_API_KEY : env.LITELLM_API_KEY;
  if (apiKey !== undefined) {
    values.apiKey = apiKey === "" ? undefined : validateApiKey(apiKey);
    fields.push("llm_api_key");
  }
  // A process-environment credential is bound to one effective origin for the
  // whole process. Without an environment base URL, the store captures the
  // first effective persisted/default origin and locks `llm_base_url` too, so
  // a Settings retarget can never carry the environment key elsewhere.
  const keyOnly = apiKey !== undefined && apiKey !== "" && baseUrl === undefined;
  if (keyOnly) fields.push("llm_base_url");
  if (env.LM_STUDIO_BASE_URL !== undefined) {
    values.lmStudioBaseUrl =
      env.LM_STUDIO_BASE_URL === "" ? undefined : parseEndpointOrigin(env.LM_STUDIO_BASE_URL, "lm_studio_base_url");
    fields.push("lm_studio_base_url");
  }
  const chatModel = env.LLM_CHAT_MODEL !== undefined ? env.LLM_CHAT_MODEL : env.LITELLM_CHAT_MODEL;
  if (chatModel !== undefined) {
    values.chatModel = validateModelId(chatModel, "default_chat_model");
    fields.push("default_chat_model");
  }
  const embedModel = env.LLM_EMBED_MODEL !== undefined ? env.LLM_EMBED_MODEL : env.LITELLM_EMBED_MODEL;
  if (embedModel !== undefined) {
    values.embedModel = validateModelId(embedModel, "default_embed_model");
    fields.push("default_embed_model");
  }
  if (env.EMBEDDING_DIM !== undefined) {
    values.embeddingDimension = validateEmbeddingDimension(env.EMBEDDING_DIM, "embedding_dimension");
    fields.push("embedding_dimension");
  }

  validateCompleteSettings({
    ...DEFAULT_LLM_SETTINGS,
    ...values,
    // Validate the environment credential against the origin it will bind to:
    // the explicit environment URL when present, otherwise the default origin
    // that key-only mode locks for the process. The store revalidates per snapshot.
    ...(values.apiKey === undefined ? {} : { apiKeyOrigin: values.llmBaseUrl ?? DEFAULT_LLM_SETTINGS.llmBaseUrl }),
  });
  return { values: Object.freeze(values), fields: Object.freeze(fields), keyOnly };
}

function decodeSettingsFile(input: unknown): EffectiveLlmSettings {
  if (!isRecord(input)) throw new SettingsValidationError();
  const allowed = new Set([
    "version",
    "llm_base_url",
    "llm_api_key",
    "llm_api_key_origin",
    "lm_studio_base_url",
    "default_chat_model",
    "default_embed_model",
    "embedding_dimension",
  ]);
  const legacy = input.version === PRE_DIMENSION_FILE_VERSION || input.version === UNBOUND_CREDENTIAL_FILE_VERSION;
  if (Object.keys(input).some((key) => !allowed.has(key)) || (!legacy && input.version !== SETTINGS_FILE_VERSION)) {
    throw new SettingsValidationError();
  }
  if (
    typeof input.llm_base_url !== "string" ||
    typeof input.default_chat_model !== "string" ||
    typeof input.default_embed_model !== "string" ||
    (input.version === PRE_DIMENSION_FILE_VERSION && input.embedding_dimension !== undefined) ||
    (input.version !== PRE_DIMENSION_FILE_VERSION && typeof input.embedding_dimension !== "number") ||
    (input.llm_api_key !== undefined && typeof input.llm_api_key !== "string") ||
    (input.llm_api_key_origin !== undefined && typeof input.llm_api_key_origin !== "string") ||
    (input.lm_studio_base_url !== undefined &&
      input.lm_studio_base_url !== null &&
      typeof input.lm_studio_base_url !== "string")
  ) {
    throw new SettingsValidationError();
  }
  if (!legacy && (input.llm_api_key === undefined) !== (input.llm_api_key_origin === undefined)) {
    // The version-3 credential and its binding are an inseparable pair; a
    // half-pair never becomes an effective credential.
    throw new SettingsValidationError();
  }
  return validateCompleteSettings({
    llmBaseUrl: input.llm_base_url,
    // Version 1 and 2 files stored an unbound credential. Preserve the valid
    // non-secret endpoint/health/model fields and deliberately drop the key;
    // the user re-enters it once and the next write persists the bound pair.
    ...(legacy || input.llm_api_key === undefined
      ? {}
      : { apiKey: input.llm_api_key, apiKeyOrigin: input.llm_api_key_origin }),
    ...(input.lm_studio_base_url === undefined || input.lm_studio_base_url === null
      ? {}
      : { lmStudioBaseUrl: input.lm_studio_base_url }),
    chatModel: input.default_chat_model,
    embedModel: input.default_embed_model,
    embeddingDimension:
      input.version === PRE_DIMENSION_FILE_VERSION
        ? DEFAULT_EMBEDDING_DIMENSION
        : validateEmbeddingDimension(input.embedding_dimension, "embedding_dimension"),
  });
}

function applyPatch(current: EffectiveLlmSettings, patch: LlmSettingsPatch): EffectiveLlmSettings {
  assertPatchTypes(patch);
  const llmBaseUrl =
    patch.llmBaseUrl === undefined ? current.llmBaseUrl : parseEndpointOrigin(patch.llmBaseUrl, "llm_base_url");
  const originUnchanged = modelEndpointOriginsEquivalent(llmBaseUrl, current.llmBaseUrl);

  let apiKey: string | undefined;
  let apiKeyOrigin: string | undefined;
  if (patch.apiKey === undefined) {
    // An omitted key preserves the pair only for an equivalent target origin;
    // a cross-origin change clears both in patch and preview.
    if (originUnchanged) {
      apiKey = current.apiKey;
      apiKeyOrigin = current.apiKeyOrigin;
    }
  } else if (patch.apiKey === null) {
    apiKey = undefined;
    apiKeyOrigin = undefined;
  } else {
    apiKey = patch.apiKey;
    apiKeyOrigin = llmBaseUrl;
  }

  return validateCompleteSettings({
    llmBaseUrl,
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(apiKeyOrigin === undefined ? {} : { apiKeyOrigin }),
    lmStudioBaseUrl:
      patch.lmStudioBaseUrl === undefined
        ? current.lmStudioBaseUrl
        : patch.lmStudioBaseUrl === null
          ? undefined
          : patch.lmStudioBaseUrl,
    chatModel:
      patch.chatModel ?? (patch.llmBaseUrl !== undefined && llmBaseUrl !== current.llmBaseUrl ? "" : current.chatModel),
    embedModel: patch.embedModel ?? current.embedModel,
    embeddingDimension: patch.embeddingDimension ?? current.embeddingDimension,
  });
}

function validateCompleteSettings(input: EffectiveLlmSettings): EffectiveLlmSettings {
  const llmBaseUrl = parseEndpointOrigin(input.llmBaseUrl, "llm_base_url");
  const apiKey = input.apiKey === undefined ? undefined : validateApiKey(input.apiKey);
  const apiKeyOrigin =
    input.apiKeyOrigin === undefined ? undefined : parseEndpointOrigin(input.apiKeyOrigin, "llm_api_key");
  if ((apiKey === undefined) !== (apiKeyOrigin === undefined)) throw new SettingsValidationError("llm_api_key");
  if (apiKey !== undefined && apiKeyOrigin !== undefined && !modelEndpointOriginsEquivalent(llmBaseUrl, apiKeyOrigin)) {
    throw new SettingsValidationError("llm_api_key");
  }
  const lmStudioBaseUrl =
    input.lmStudioBaseUrl === undefined ? undefined : parseEndpointOrigin(input.lmStudioBaseUrl, "lm_studio_base_url");
  const chatModel = input.chatModel === "" ? "" : validateModelId(input.chatModel, "default_chat_model");
  const embedModel = validateModelId(input.embedModel, "default_embed_model");
  const embeddingDimension = validateEmbeddingDimension(input.embeddingDimension, "embedding_dimension");
  if (sameLlmModel(chatModel, embedModel)) throw new SettingsValidationError("default_embed_model");

  return {
    llmBaseUrl,
    ...(apiKey === undefined ? {} : { apiKey, apiKeyOrigin }),
    ...(lmStudioBaseUrl === undefined || modelEndpointOriginsEquivalent(llmBaseUrl, lmStudioBaseUrl)
      ? {}
      : { lmStudioBaseUrl }),
    chatModel,
    embedModel,
    embeddingDimension,
  };
}

function assertPatchTypes(patch: LlmSettingsPatch): void {
  if (!isRecord(patch)) throw new SettingsValidationError();
  if (patch.llmBaseUrl !== undefined && typeof patch.llmBaseUrl !== "string") {
    throw new SettingsValidationError("llm_base_url");
  }
  if (patch.apiKey !== undefined && patch.apiKey !== null && typeof patch.apiKey !== "string") {
    throw new SettingsValidationError("llm_api_key");
  }
  if (
    patch.lmStudioBaseUrl !== undefined &&
    patch.lmStudioBaseUrl !== null &&
    typeof patch.lmStudioBaseUrl !== "string"
  ) {
    throw new SettingsValidationError("lm_studio_base_url");
  }
  if (patch.chatModel !== undefined && typeof patch.chatModel !== "string") {
    throw new SettingsValidationError("default_chat_model");
  }
  if (patch.embedModel !== undefined && typeof patch.embedModel !== "string") {
    throw new SettingsValidationError("default_embed_model");
  }
  if (patch.embeddingDimension !== undefined) {
    validateEmbeddingDimension(patch.embeddingDimension, "embedding_dimension");
  }
}

function validateModelId(value: string, field: "default_chat_model" | "default_embed_model"): string {
  const model = value.trim();
  if (model.length < 1 || model.length > MODEL_ID_MAX_CHARS || containsControlCharacter(model)) {
    throw new SettingsValidationError(field);
  }
  return model;
}

function validateApiKey(value: string): string {
  if (value.length < 1 || value.length > MAX_API_KEY_CHARS || containsHeaderBreakingCharacter(value)) {
    throw new SettingsValidationError("llm_api_key");
  }
  return value;
}

function validateEmbeddingDimension(value: unknown, field: "embedding_dimension"): number {
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || Number(parsed) < 1 || Number(parsed) > MAX_EMBEDDING_DIMENSION) {
    throw new SettingsValidationError(field);
  }
  return Number(parsed);
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function containsHeaderBreakingCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0 || code === 10 || code === 13) return true;
  }
  return false;
}

function parseEndpointOrigin(value: string, field: LlmSettingField): string {
  if (value.length < 1 || value.length > MAX_ENDPOINT_CHARS) throw new SettingsValidationError(field);
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new SettingsValidationError(field);
  }
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash ||
    (endpoint.protocol === "http:" &&
      !isLoopbackHostname(endpoint.hostname) &&
      !endpoint.hostname.toLowerCase().endsWith(".local"))
  ) {
    throw new SettingsValidationError(field);
  }
  return endpoint.origin;
}

function patchFields(patch: LlmSettingsPatch): Set<LlmSettingField> {
  const fields = new Set<LlmSettingField>();
  if (Object.prototype.hasOwnProperty.call(patch, "llmBaseUrl")) fields.add("llm_base_url");
  if (Object.prototype.hasOwnProperty.call(patch, "apiKey")) fields.add("llm_api_key");
  if (Object.prototype.hasOwnProperty.call(patch, "lmStudioBaseUrl")) fields.add("lm_studio_base_url");
  if (Object.prototype.hasOwnProperty.call(patch, "chatModel")) fields.add("default_chat_model");
  if (Object.prototype.hasOwnProperty.call(patch, "embedModel")) fields.add("default_embed_model");
  if (Object.prototype.hasOwnProperty.call(patch, "embeddingDimension")) fields.add("embedding_dimension");
  return fields;
}

async function writeSettingsFileAtomically(
  filename: string,
  settings: EffectiveLlmSettings,
  filesystem: SettingsFileSystem
): Promise<void> {
  const directory = path.dirname(filename);
  await filesystem.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(filename)}.${process.pid}.${randomUUID()}.tmp`);
  const payload: PersistedSettingsFile = {
    version: SETTINGS_FILE_VERSION,
    llm_base_url: settings.llmBaseUrl,
    ...(settings.apiKey === undefined || settings.apiKeyOrigin === undefined
      ? {}
      : { llm_api_key: settings.apiKey, llm_api_key_origin: settings.apiKeyOrigin }),
    ...(settings.lmStudioBaseUrl === undefined ? {} : { lm_studio_base_url: settings.lmStudioBaseUrl }),
    default_chat_model: settings.chatModel,
    default_embed_model: settings.embedModel,
    embedding_dimension: settings.embeddingDimension,
  };
  let handle: Awaited<ReturnType<typeof fsPromises.open>> | undefined;
  try {
    handle = await filesystem.open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
    // Every fallible hardening step precedes the rename. The mode repair runs
    // on the temporary handle before publication so no throwing step can follow
    // the durable commit.
    const temporaryStat = await handle.stat();
    if ((temporaryStat.mode & 0o777) !== 0o600) await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    // The rename is the single durable commit point of a settings write.
    await filesystem.rename(temporary, filename);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await filesystem.unlink(temporary).catch(() => undefined);
    throw error;
  }
  // Directory fsync stays best-effort and content-free after commit.
  await syncDirectory(directory, filesystem);
}

async function syncDirectory(directory: string, filesystem: SettingsFileSystem): Promise<void> {
  let handle: Awaited<ReturnType<typeof fsPromises.open>> | undefined;
  try {
    handle = await filesystem.open(directory, "r");
    await handle.sync();
  } catch {
    // The file itself was fsynced; directory fsync is a best-effort portability hardening.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) return normalized.split(".", 1)[0] === "127";
  if (ipVersion === 6) return normalized === "::1";
  return normalized === "localhost" || normalized.endsWith(".localhost");
}

function effectivePort(url: URL): string {
  if (url.port) return url.port;
  return url.protocol === "https:" ? "443" : "80";
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}
