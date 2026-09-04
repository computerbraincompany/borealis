import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  formatApiError,
  modelsApi,
  settingsApi,
  type ModelPairQualificationResult,
  type ProviderSettingName,
  type ProviderSettingsPatch,
  type ProviderSettingsResponse,
} from "@/lib/api";

export interface ProviderSettingsForm {
  llm_base_url: string;
  llm_api_key: string;
  lm_studio_base_url: string;
  default_chat_model: string;
  default_embed_model: string;
  embedding_dimension: string;
}

export interface ProviderSettingsFeedback {
  kind: "error" | "success";
  message: string;
}

type ProviderSettingsAction = "clearing-key" | "qualifying" | "saving" | "testing" | null;

const EMPTY_FORM: ProviderSettingsForm = {
  llm_base_url: "",
  llm_api_key: "",
  lm_studio_base_url: "",
  default_chat_model: "",
  default_embed_model: "",
  embedding_dimension: "",
};

function formFromSettings(settings: ProviderSettingsResponse): ProviderSettingsForm {
  return {
    llm_base_url: settings.llm_base_url,
    llm_api_key: "",
    lm_studio_base_url: settings.lm_studio_base_url ?? "",
    default_chat_model: settings.default_chat_model,
    default_embed_model: settings.default_embed_model,
    embedding_dimension: String(settings.embedding_dimension),
  };
}

function isManaged(settings: ProviderSettingsResponse, field: ProviderSettingName): boolean {
  return settings.managed_by_env[field] === true;
}

function normalizeOptionalUrl(value: string): string | null {
  return value.trim() || null;
}

function buildPatch(
  settings: ProviderSettingsResponse,
  form: ProviderSettingsForm,
  onlyChanges: boolean,
): ProviderSettingsPatch {
  const patch: ProviderSettingsPatch = {};
  const llmBaseUrl = form.llm_base_url.trim();
  const defaultChatModel = form.default_chat_model.trim();
  const defaultEmbedModel = form.default_embed_model.trim();
  const embeddingDimension = Number(form.embedding_dimension);
  const lmStudioBaseUrl = isRemoteModelEndpoint(llmBaseUrl) ? normalizeOptionalUrl(form.lm_studio_base_url) : null;

  if (!isManaged(settings, "llm_base_url") && (!onlyChanges || llmBaseUrl !== settings.llm_base_url)) {
    patch.llm_base_url = llmBaseUrl;
  }
  if (!isManaged(settings, "lm_studio_base_url") && (!onlyChanges || lmStudioBaseUrl !== settings.lm_studio_base_url)) {
    patch.lm_studio_base_url = lmStudioBaseUrl;
  }
  if (
    !isManaged(settings, "default_chat_model") &&
    (!onlyChanges || defaultChatModel !== settings.default_chat_model)
  ) {
    patch.default_chat_model = defaultChatModel;
  }
  if (
    !isManaged(settings, "default_embed_model") &&
    (!onlyChanges || defaultEmbedModel !== settings.default_embed_model)
  ) {
    patch.default_embed_model = defaultEmbedModel;
  }
  if (
    !isManaged(settings, "embedding_dimension") &&
    (!onlyChanges || embeddingDimension !== settings.embedding_dimension)
  ) {
    patch.embedding_dimension = embeddingDimension;
  }
  if (!isManaged(settings, "llm_api_key") && form.llm_api_key.trim()) {
    // Preserve the user's exact non-blank secret. Whitespace-only input means
    // "keep the current key" and is deliberately omitted from the request.
    patch.llm_api_key = form.llm_api_key;
  }

  return patch;
}

function validateUrl(value: string, label: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return `${label} must be a valid HTTP or HTTPS URL.`;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `${label} must be a valid HTTP or HTTPS URL.`;
  }
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    return `${label} must be an origin without a path, query, fragment, or credentials.`;
  }

  const loopback = isLoopbackHostname(parsed.hostname);
  if (!loopback && parsed.protocol !== "https:") return "Non-loopback endpoints must use HTTPS.";
  return null;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "::1" ||
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

export function isRemoteModelEndpoint(value: string): boolean {
  try {
    const hostname = new URL(value.trim()).hostname;
    return !isLoopbackHostname(hostname);
  } catch {
    return value.trim().length > 0;
  }
}

/** Match the server's origin canonicalization for draft-specific remote consent. */
export function canonicalProviderOrigin(value: string): string | null {
  try {
    return new URL(value.trim()).origin;
  } catch {
    return null;
  }
}

export function validateProviderSettings(form: ProviderSettingsForm): string | null {
  const baseUrl = form.llm_base_url.trim();
  const chatModel = form.default_chat_model.trim();
  const embedModel = form.default_embed_model.trim();
  const embeddingDimension = Number(form.embedding_dimension);

  const baseUrlError = validateUrl(baseUrl, "Chat endpoint URL");
  if (baseUrlError) return baseUrlError;
  if (!chatModel || chatModel.length > 256) return "Default chat model must contain 1 to 256 characters.";
  if (!embedModel || embedModel.length > 256) return "Embedding model must contain 1 to 256 characters.";
  if (chatModel === embedModel) return "Chat and embedding models must be different.";
  if (!Number.isSafeInteger(embeddingDimension) || embeddingDimension < 1 || embeddingDimension > 16_384) {
    return "Embedding dimension must be a whole number from 1 to 16,384.";
  }

  const lmStudioUrl = form.lm_studio_base_url.trim();
  if (isRemoteModelEndpoint(baseUrl) && lmStudioUrl) {
    return validateUrl(lmStudioUrl, "LM Studio URL");
  }
  return null;
}

export function useProviderSettings() {
  const [settings, setSettings] = useState<ProviderSettingsResponse | null>(null);
  const [form, setForm] = useState<ProviderSettingsForm>(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [action, setAction] = useState<ProviderSettingsAction>(null);
  const [feedback, setFeedback] = useState<ProviderSettingsFeedback | null>(null);
  const [qualification, setQualification] = useState<ModelPairQualificationResult | null>(null);
  const [qualificationAcknowledgedOrigin, setQualificationAcknowledgedOrigin] = useState<string | null>(null);
  const mounted = useRef(false);
  const actionRef = useRef<ProviderSettingsAction>(null);
  const actionRequestRef = useRef(0);
  const actionController = useRef<AbortController | null>(null);
  const loadController = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    if (mounted.current) {
      setLoading(true);
      setLoadError(null);
    }

    try {
      const next = await settingsApi.get(controller.signal);
      if (!controller.signal.aborted && mounted.current) {
        setSettings(next);
        setForm(formFromSettings(next));
        setFeedback(null);
        setQualification(null);
        setQualificationAcknowledgedOrigin(null);
        setLoading(false);
      }
    } catch (failure: unknown) {
      if (!controller.signal.aborted && mounted.current) {
        setLoading(false);
        setLoadError(formatApiError(failure, "Provider settings are temporarily unavailable."));
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      loadController.current?.abort();
      actionRequestRef.current += 1;
      actionController.current?.abort();
      actionController.current = null;
      actionRef.current = null;
    };
  }, [load]);

  const setField = useCallback(<Field extends keyof ProviderSettingsForm>(field: Field, value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
    setFeedback(null);
    setQualification(null);
    setQualificationAcknowledgedOrigin(null);
  }, []);

  const qualificationRemoteOrigin = useMemo(
    () => (isRemoteModelEndpoint(form.llm_base_url) ? canonicalProviderOrigin(form.llm_base_url) : null),
    [form.llm_base_url],
  );

  const setQualificationRemoteAcknowledged = useCallback(
    (acknowledged: boolean) => {
      setQualificationAcknowledgedOrigin(acknowledged ? qualificationRemoteOrigin : null);
      setQualification(null);
      setFeedback(null);
    },
    [qualificationRemoteOrigin],
  );

  const save = useCallback(async (): Promise<boolean> => {
    if (!settings || actionRef.current) return false;
    const validationError = validateProviderSettings(form);
    if (validationError) {
      setFeedback({ kind: "error", message: validationError });
      return false;
    }

    const patch = buildPatch(settings, form, true);
    if (Object.keys(patch).length === 0) return false;

    actionRef.current = "saving";
    const requestId = ++actionRequestRef.current;
    const controller = new AbortController();
    actionController.current = controller;
    setAction("saving");
    setFeedback(null);
    try {
      const next = await settingsApi.update(patch, controller.signal);
      if (
        mounted.current &&
        !controller.signal.aborted &&
        requestId === actionRequestRef.current &&
        actionController.current === controller
      ) {
        setSettings(next);
        setForm(formFromSettings(next));
        setFeedback({ kind: "success", message: "Settings saved. New model requests will use this connection." });
      }
      return !controller.signal.aborted && requestId === actionRequestRef.current;
    } catch (failure: unknown) {
      if (
        mounted.current &&
        !controller.signal.aborted &&
        requestId === actionRequestRef.current &&
        actionController.current === controller
      ) {
        setFeedback({ kind: "error", message: formatApiError(failure, "Settings could not be saved.") });
      }
      return false;
    } finally {
      if (requestId === actionRequestRef.current && actionController.current === controller) {
        actionController.current = null;
        actionRef.current = null;
        if (mounted.current) setAction(null);
      }
    }
  }, [form, settings]);

  const testConnection = useCallback(async (): Promise<boolean> => {
    if (!settings || actionRef.current) return false;
    const validationError = validateProviderSettings(form);
    if (validationError) {
      setFeedback({ kind: "error", message: validationError });
      return false;
    }

    actionRef.current = "testing";
    const requestId = ++actionRequestRef.current;
    const controller = new AbortController();
    actionController.current = controller;
    setAction("testing");
    setFeedback(null);
    try {
      const result = await settingsApi.testConnection(buildPatch(settings, form, false), controller.signal);
      if (
        mounted.current &&
        !controller.signal.aborted &&
        requestId === actionRequestRef.current &&
        actionController.current === controller
      ) {
        const latency = Number.isFinite(result.latency_ms)
          ? ` in ${Math.max(0, Math.round(result.latency_ms))} ms`
          : "";
        setFeedback({ kind: "success", message: `Connection ready${latency}.` });
      }
      return !controller.signal.aborted && requestId === actionRequestRef.current;
    } catch (failure: unknown) {
      if (
        mounted.current &&
        !controller.signal.aborted &&
        requestId === actionRequestRef.current &&
        actionController.current === controller
      ) {
        setFeedback({ kind: "error", message: formatApiError(failure, "Connection test could not be completed.") });
      }
      return false;
    } finally {
      if (requestId === actionRequestRef.current && actionController.current === controller) {
        actionController.current = null;
        actionRef.current = null;
        if (mounted.current) setAction(null);
      }
    }
  }, [form, settings]);

  const qualifyModelPair = useCallback(async (): Promise<boolean> => {
    if (!settings || actionRef.current) return false;
    const validationError = validateProviderSettings(form);
    if (validationError) {
      setFeedback({ kind: "error", message: validationError });
      return false;
    }
    if (qualificationRemoteOrigin && qualificationAcknowledgedOrigin !== qualificationRemoteOrigin) {
      setFeedback({
        kind: "error",
        message: "Acknowledge the exact remote provider origin before running model qualification.",
      });
      return false;
    }

    actionRef.current = "qualifying";
    const requestId = ++actionRequestRef.current;
    const controller = new AbortController();
    actionController.current = controller;
    setAction("qualifying");
    setFeedback(null);
    setQualification(null);
    try {
      const draft = buildPatch(settings, form, false);
      // The LM Studio URL is a health-only setting and is not part of model
      // qualification's deliberately narrow draft contract.
      delete draft.lm_studio_base_url;
      const result = await modelsApi.qualify(
        {
          ...draft,
          expected_dimension: Number(form.embedding_dimension),
          ...(qualificationRemoteOrigin ? { remote_egress_ack_origin: qualificationRemoteOrigin } : {}),
        },
        controller.signal,
      );
      if (
        mounted.current &&
        !controller.signal.aborted &&
        requestId === actionRequestRef.current &&
        actionController.current === controller
      ) {
        setQualification(result);
        setFeedback(
          result.chat.qualified && result.embedding.qualified
            ? { kind: "success", message: "Chat tools and embeddings qualified for this draft." }
            : { kind: "error", message: "This draft did not pass every model qualification check." },
        );
      }
      return (
        !controller.signal.aborted &&
        requestId === actionRequestRef.current &&
        result.chat.qualified &&
        result.embedding.qualified
      );
    } catch (failure: unknown) {
      if (
        mounted.current &&
        !controller.signal.aborted &&
        requestId === actionRequestRef.current &&
        actionController.current === controller
      ) {
        setFeedback({ kind: "error", message: formatApiError(failure, "Model qualification could not be completed.") });
      }
      return false;
    } finally {
      if (requestId === actionRequestRef.current && actionController.current === controller) {
        actionController.current = null;
        actionRef.current = null;
        if (mounted.current) setAction(null);
      }
    }
  }, [form, qualificationAcknowledgedOrigin, qualificationRemoteOrigin, settings]);

  const clearApiKey = useCallback(async (): Promise<boolean> => {
    if (!settings || actionRef.current || !settings.llm_api_key_configured || isManaged(settings, "llm_api_key")) {
      return false;
    }

    actionRef.current = "clearing-key";
    const requestId = ++actionRequestRef.current;
    const controller = new AbortController();
    actionController.current = controller;
    setAction("clearing-key");
    setFeedback(null);
    try {
      const next = await settingsApi.update({ llm_api_key: null }, controller.signal);
      if (
        mounted.current &&
        !controller.signal.aborted &&
        requestId === actionRequestRef.current &&
        actionController.current === controller
      ) {
        setSettings(next);
        // Clearing the credential is independent of unsaved endpoint/model
        // edits. Preserve those drafts while ensuring no typed secret remains.
        setForm((current) => ({ ...current, llm_api_key: "" }));
        setQualification(null);
        setQualificationAcknowledgedOrigin(null);
        setFeedback({ kind: "success", message: "Saved API key cleared." });
      }
      return !controller.signal.aborted && requestId === actionRequestRef.current;
    } catch (failure: unknown) {
      if (
        mounted.current &&
        !controller.signal.aborted &&
        requestId === actionRequestRef.current &&
        actionController.current === controller
      ) {
        setFeedback({ kind: "error", message: formatApiError(failure, "Saved API key could not be cleared.") });
      }
      return false;
    } finally {
      if (requestId === actionRequestRef.current && actionController.current === controller) {
        actionController.current = null;
        actionRef.current = null;
        if (mounted.current) setAction(null);
      }
    }
  }, [settings]);

  const hasChanges = useMemo(
    () => !!settings && Object.keys(buildPatch(settings, form, true)).length > 0,
    [form, settings],
  );
  const hasNonEmbeddingChanges = useMemo(() => {
    if (!settings) return false;
    const patch = buildPatch(settings, form, true);
    delete patch.default_embed_model;
    delete patch.embedding_dimension;
    return Object.keys(patch).length > 0;
  }, [form, settings]);
  const qualificationReady = Boolean(qualification?.chat.qualified && qualification.embedding.qualified);

  return {
    settings,
    form,
    loading,
    loadError,
    action,
    feedback,
    qualification,
    qualificationReady,
    qualificationRemoteOrigin,
    qualificationRemoteAcknowledged:
      qualificationRemoteOrigin !== null && qualificationAcknowledgedOrigin === qualificationRemoteOrigin,
    hasChanges,
    hasNonEmbeddingChanges,
    remoteEndpoint: isRemoteModelEndpoint(form.llm_base_url),
    setField,
    reload: load,
    save,
    testConnection,
    qualifyModelPair,
    setQualificationRemoteAcknowledged,
    clearApiKey,
  };
}
