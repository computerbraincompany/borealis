import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { sameLlmModel } from "./llmAliases.js";

export const SETTINGS_FILE_VERSION = 1 as const;
export const DEFAULT_LLM_SETTINGS = Object.freeze({
  llmBaseUrl: "http://127.0.0.1:1234",
  chatModel: "qwen-chat",
  embedModel: "nomic-embed",
} satisfies EffectiveLlmSettings);

const MAX_SETTINGS_FILE_BYTES = 32 * 1024;
const MAX_ENDPOINT_CHARS = 2_048;
const MAX_API_KEY_CHARS = 8_192;
const MODEL_ID_MAX_CHARS = 256;

export type LlmSettingField =
  "llm_base_url" | "llm_api_key" | "lm_studio_base_url" | "default_chat_model" | "default_embed_model";

export interface EffectiveLlmSettings {
  readonly llmBaseUrl: string;
  readonly apiKey?: string;
  readonly lmStudioBaseUrl?: string;
  readonly chatModel: string;
  readonly embedModel: string;
}

export interface LlmSettingsPatch {
  readonly llmBaseUrl?: string;
  readonly apiKey?: string | null;
  readonly lmStudioBaseUrl?: string | null;
  readonly chatModel?: string;
  readonly embedModel?: string;
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
  readonly managed_by_env: Readonly<Record<LlmSettingField, boolean>>;
}

export interface SettingsStore {
  read(): Promise<SettingsSnapshot>;
  patch(patch: LlmSettingsPatch): Promise<SettingsSnapshot>;
  preview(patch: LlmSettingsPatch): Promise<SettingsSnapshot>;
  subscribe(listener: (snapshot: SettingsSnapshot) => void): () => void;
}

export interface CreateSettingsStoreOptions {
  readonly path: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

interface PersistedSettingsFile {
  readonly version: typeof SETTINGS_FILE_VERSION;
  readonly llm_base_url: string;
  readonly llm_api_key?: string;
  readonly lm_studio_base_url?: string;
  readonly default_chat_model: string;
  readonly default_embed_model: string;
}

interface PersistedRead {
  readonly settings: EffectiveLlmSettings;
  readonly status: SettingsSnapshot["fileStatus"];
}

interface EnvironmentSettings {
  readonly values: Partial<EffectiveLlmSettings>;
  readonly fields: readonly LlmSettingField[];
}

interface MutableEnvironmentSettings {
  llmBaseUrl?: string;
  apiKey?: string;
  lmStudioBaseUrl?: string;
  chatModel?: string;
  embedModel?: string;
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
export function createSettingsStore(options: CreateSettingsStoreOptions): SettingsStore {
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
    managed_by_env: {
      llm_base_url: managed.has("llm_base_url"),
      llm_api_key: managed.has("llm_api_key"),
      lm_studio_base_url: managed.has("lm_studio_base_url"),
      default_chat_model: managed.has("default_chat_model"),
      default_embed_model: managed.has("default_embed_model"),
    },
  };
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

class FileSettingsStore implements SettingsStore {
  readonly #filename: string;
  readonly #environment: EnvironmentSettings;
  readonly #listeners = new Set<(snapshot: SettingsSnapshot) => void>();
  #writeTail: Promise<void> = Promise.resolve();

  constructor(options: CreateSettingsStoreOptions) {
    this.#filename = path.resolve(options.path);
    this.#environment = resolveEnvironmentSettings(options.env ?? process.env);
  }

  async read(): Promise<SettingsSnapshot> {
    await this.#writeTail;
    return this.#snapshot(await this.#readPersisted());
  }

  patch(patch: LlmSettingsPatch): Promise<SettingsSnapshot> {
    return this.#serialize(async () => {
      this.#assertPatchable(patch);
      const persisted = await this.#readPersisted();
      const settings = applyPatch(persisted.settings, patch);
      await writeSettingsFileAtomically(this.#filename, settings);
      const snapshot = this.#snapshot({ settings, status: "loaded" });
      for (const listener of this.#listeners) {
        try {
          listener(snapshot);
        } catch {
          // A model-client subscriber cannot roll back an already durable file.
        }
      }
      return snapshot;
    });
  }

  preview(patch: LlmSettingsPatch): Promise<SettingsSnapshot> {
    return this.#serialize(async () => {
      this.#assertPatchable(patch);
      const persisted = await this.#readPersisted();
      return this.#snapshot({ settings: applyPatch(persisted.settings, patch), status: persisted.status });
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

  #assertPatchable(patch: LlmSettingsPatch): void {
    const patchedFields = patchFields(patch);
    for (const field of this.#environment.fields) {
      if (patchedFields.has(field)) throw new SettingsEnvironmentOverrideError(field);
    }
  }

  #snapshot(persisted: PersistedRead): SettingsSnapshot {
    const settings = validateCompleteSettings({ ...persisted.settings, ...this.#environment.values });
    return Object.freeze({
      settings: Object.freeze(settings),
      environmentOverrides: this.#environment.fields,
      fileStatus: persisted.status,
    });
  }

  async #readPersisted(): Promise<PersistedRead> {
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(this.#filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
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
  const values: MutableEnvironmentSettings = {};
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

  validateCompleteSettings({ ...DEFAULT_LLM_SETTINGS, ...values });
  return { values: Object.freeze(values), fields: Object.freeze(fields) };
}

function decodeSettingsFile(input: unknown): EffectiveLlmSettings {
  if (!isRecord(input)) throw new SettingsValidationError();
  const allowed = new Set([
    "version",
    "llm_base_url",
    "llm_api_key",
    "lm_studio_base_url",
    "default_chat_model",
    "default_embed_model",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key)) || input.version !== SETTINGS_FILE_VERSION) {
    throw new SettingsValidationError();
  }
  if (
    typeof input.llm_base_url !== "string" ||
    typeof input.default_chat_model !== "string" ||
    typeof input.default_embed_model !== "string" ||
    (input.llm_api_key !== undefined && typeof input.llm_api_key !== "string") ||
    (input.lm_studio_base_url !== undefined &&
      input.lm_studio_base_url !== null &&
      typeof input.lm_studio_base_url !== "string")
  ) {
    throw new SettingsValidationError();
  }
  return validateCompleteSettings({
    llmBaseUrl: input.llm_base_url,
    ...(input.llm_api_key === undefined ? {} : { apiKey: input.llm_api_key }),
    ...(input.lm_studio_base_url === undefined || input.lm_studio_base_url === null
      ? {}
      : { lmStudioBaseUrl: input.lm_studio_base_url }),
    chatModel: input.default_chat_model,
    embedModel: input.default_embed_model,
  });
}

function applyPatch(current: EffectiveLlmSettings, patch: LlmSettingsPatch): EffectiveLlmSettings {
  assertPatchTypes(patch);
  return validateCompleteSettings({
    llmBaseUrl: patch.llmBaseUrl ?? current.llmBaseUrl,
    apiKey: patch.apiKey === undefined ? current.apiKey : patch.apiKey === null ? undefined : patch.apiKey,
    lmStudioBaseUrl:
      patch.lmStudioBaseUrl === undefined
        ? current.lmStudioBaseUrl
        : patch.lmStudioBaseUrl === null
          ? undefined
          : patch.lmStudioBaseUrl,
    chatModel: patch.chatModel ?? current.chatModel,
    embedModel: patch.embedModel ?? current.embedModel,
  });
}

function validateCompleteSettings(input: EffectiveLlmSettings): EffectiveLlmSettings {
  const llmBaseUrl = parseEndpointOrigin(input.llmBaseUrl, "llm_base_url");
  const apiKey = input.apiKey === undefined ? undefined : validateApiKey(input.apiKey);
  const lmStudioBaseUrl =
    input.lmStudioBaseUrl === undefined ? undefined : parseEndpointOrigin(input.lmStudioBaseUrl, "lm_studio_base_url");
  const chatModel = validateModelId(input.chatModel, "default_chat_model");
  const embedModel = validateModelId(input.embedModel, "default_embed_model");
  if (sameLlmModel(chatModel, embedModel)) throw new SettingsValidationError("default_embed_model");

  return {
    llmBaseUrl,
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(lmStudioBaseUrl === undefined || modelEndpointOriginsEquivalent(llmBaseUrl, lmStudioBaseUrl)
      ? {}
      : { lmStudioBaseUrl }),
    chatModel,
    embedModel,
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

function parseEndpointOrigin(value: string, field: "llm_base_url" | "lm_studio_base_url"): string {
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
    (endpoint.protocol === "http:" && !isLoopbackHostname(endpoint.hostname))
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
  return fields;
}

async function writeSettingsFileAtomically(filename: string, settings: EffectiveLlmSettings): Promise<void> {
  const directory = path.dirname(filename);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(filename)}.${process.pid}.${randomUUID()}.tmp`);
  const payload: PersistedSettingsFile = {
    version: SETTINGS_FILE_VERSION,
    llm_base_url: settings.llmBaseUrl,
    ...(settings.apiKey === undefined ? {} : { llm_api_key: settings.apiKey }),
    ...(settings.lmStudioBaseUrl === undefined ? {} : { lm_studio_base_url: settings.lmStudioBaseUrl }),
    default_chat_model: settings.chatModel,
    default_embed_model: settings.embedModel,
  };
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, filename);
    await fs.chmod(filename, 0o600);
    await syncDirectory(directory);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(directory, "r");
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
