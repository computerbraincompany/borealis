import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  Check,
  Cloud,
  Cpu,
  MessageSquare,
  Plug,
  FlaskConical,
  HardDrive,
  LoaderCircle,
  LogOut,
  Monitor,
  Moon,
  RefreshCw,
  Save,
  Sun,
  UserRound,
} from "lucide-react";
import { useTheme, type ThemeChoice } from "@/components/ThemeProvider";
import { ContainedPanel } from "@/components/ContainedPanel";
import { SystemHealthPanel } from "@/components/SystemHealthPanel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useModelCatalog } from "@/hooks/useModelCatalog";
import { embeddingMigrationErrorMessage, useEmbeddingMigration } from "@/hooks/useEmbeddingMigration";
import { useProviderSettings } from "@/hooks/useProviderSettings";
import { useSystemHealth } from "@/hooks/useSystemHealth";
import { useEgressAudit } from "@/hooks/useEgressAudit";
import { clearSession, formatApiError, getUser, preferencesApi } from "@/lib/api";
import { hasDesktopBridge } from "@/lib/desktopBootstrap";
import { EGRESS_PAYLOAD_CLASSES } from "@/lib/egressDisclosure";
import { cn, formatDate } from "@/lib/utils";

type SettingsSection = "system" | "provider" | "chat" | "embeddings" | "engine" | "appearance" | "account";

const SECTIONS: Array<{ value: SettingsSection; label: string; icon: typeof Activity }> = [
  { value: "system", label: "System", icon: Activity },
  { value: "provider", label: "Provider", icon: Plug },
  { value: "chat", label: "Chat models", icon: MessageSquare },
  { value: "embeddings", label: "Embeddings", icon: HardDrive },
  { value: "engine", label: "Local engine", icon: Cpu },
  { value: "appearance", label: "Appearance", icon: Monitor },
  { value: "account", label: "Account", icon: UserRound },
];

const APPEARANCE_OPTIONS: Array<{
  value: ThemeChoice;
  label: string;
  description: string;
  icon: typeof Sun;
}> = [
  { value: "light", label: "Light", description: "Always use the light theme.", icon: Sun },
  { value: "dark", label: "Dark", description: "Always use the dark theme.", icon: Moon },
  { value: "system", label: "System", description: "Match your operating system setting.", icon: Monitor },
];

interface SettingsViewProps {
  onClose?: () => void;
}

interface PersonalDefaultFeedback {
  kind: "error" | "success";
  message: string;
}

function ManagedByEnvironment() {
  return (
    <span className="rounded border bg-secondary px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      Managed by environment
    </span>
  );
}

function qualificationReason(reason: string): string {
  const labels: Record<string, string> = {
    qualified: "Ready",
    unreachable: "Provider could not complete the request. Check the connection and loaded model.",
    timeout: "The model took too long. Load it in your provider, then try again.",
    "response-truncated": "The model’s test response was cut short. Try again or choose another chat model.",
    "tool-call-missing": "No tool call returned",
    "tool-call-invalid": "Invalid tool call returned",
    "embedding-invalid": "Invalid embedding returned",
    "dimension-mismatch": "Dimension mismatch",
  };
  return labels[reason] ?? "Check failed";
}

function migrationPhaseLabel(phase: string): string {
  const labels: Record<string, string> = {
    idle: "No migration active",
    snapshotting: "Capturing source snapshot",
    building: "Building replacement index",
    ready_to_apply: "Ready to apply",
    apply_pending: "Applying search index",
    failed: "Migration stopped",
  };
  return labels[phase] ?? "Status unavailable";
}

export function SettingsView({ onClose }: SettingsViewProps) {
  const [section, setSection] = useState<SettingsSection>("system");
  const [personalDefault, setPersonalDefault] = useState<string | null>(null);
  const [personalDefaultLoading, setPersonalDefaultLoading] = useState(true);
  const [personalDefaultLoadError, setPersonalDefaultLoadError] = useState<string | null>(null);
  const [personalDefaultSaving, setPersonalDefaultSaving] = useState(false);
  const [personalDefaultFeedback, setPersonalDefaultFeedback] = useState<PersonalDefaultFeedback | null>(null);
  const personalDefaultMountedRef = useRef(false);
  const personalDefaultActiveRef = useRef(false);
  const personalDefaultLoadRequestRef = useRef(0);
  const personalDefaultLoadAbortRef = useRef<AbortController | null>(null);
  const personalDefaultSaveRequestRef = useRef(0);
  const personalDefaultSaveAbortRef = useRef<AbortController | null>(null);
  const personalDefaultSavingRef = useRef(false);
  const { catalog, loading, error, refresh } = useModelCatalog();
  const providerScope = section === "chat" ? "chat" : section === "embeddings" ? "embeddings" : "connection";
  const provider = useProviderSettings(providerScope);
  const providerPanel = section === "provider" || section === "chat" || section === "embeddings";
  const migration = useEmbeddingMigration(providerPanel);
  const panelCopy = {
    provider: { title: "Provider", description: "Connect the model service used for chat and document search." },
    chat: {
      title: "Chat models",
      description: "Choose the workspace default for new conversations. Existing chats keep their model.",
    },
    embeddings: {
      title: "Embeddings",
      description: "Choose how documents are indexed for search. Model changes rebuild the workspace index.",
    },
  };
  const activePanel = panelCopy[section === "chat" ? "chat" : section === "embeddings" ? "embeddings" : "provider"];
  const panelBusy = provider.action !== null || migration.action !== null;
  const systemHealth = useSystemHealth();
  const egressAudit = useEgressAudit(50, section === "system");
  const { theme, resolvedTheme, setTheme } = useTheme();
  const user = getUser();
  const desktopWorkspace = hasDesktopBridge();
  const discoveryLive = catalog?.discovery === "live";
  const providerConnectionChanged = Boolean(
    provider.settings &&
      (provider.form.llm_base_url.trim() !== provider.settings.llm_base_url || provider.form.llm_api_key.trim()),
  );
  const availableModels = catalog?.available_models ?? catalog?.models ?? [];
  const embeddingDimension = Number(provider.form.embedding_dimension);
  const migrationActive = Boolean(migration.status && migration.status.phase !== "idle");
  const embeddingTargetChanged = Boolean(
    provider.settings &&
      (provider.form.default_embed_model.trim() !== provider.settings.default_embed_model ||
        embeddingDimension !== provider.settings.embedding_dimension),
  );
  const embeddingIdentityManaged = Boolean(
    provider.settings?.managed_by_env.default_embed_model || provider.settings?.managed_by_env.embedding_dimension,
  );
  const canStartMigration = Boolean(
    !migration.loadError &&
      migration.status?.phase === "idle" &&
      embeddingTargetChanged &&
      provider.qualificationReady &&
      !provider.hasNonEmbeddingChanges &&
      !embeddingIdentityManaged &&
      provider.action === null &&
      migration.action === null,
  );
  const reloadProvider = provider.reload;
  const previousMigrationPhase = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (previousMigrationPhase.current === "apply_pending" && migration.status?.phase === "idle") {
      void reloadProvider();
      void refresh(true);
    }
    previousMigrationPhase.current = migration.status?.phase;
  }, [migration.status?.phase, reloadProvider, refresh]);

  const migrationDetailsRef = useRef<HTMLElement>(null);
  const saveEmbeddingSettings = async () => {
    if (!canStartMigration) return;
    await migration.start(provider.form.default_embed_model, embeddingDimension);
    migrationDetailsRef.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  };
  const migrationProgress = migration.status?.chunk_count
    ? Math.min(100, Math.round((migration.status.indexed_count / migration.status.chunk_count) * 100))
    : 0;

  const invalidatePersonalDefaultRequests = useCallback(() => {
    personalDefaultLoadRequestRef.current += 1;
    personalDefaultLoadAbortRef.current?.abort();
    personalDefaultLoadAbortRef.current = null;
    personalDefaultSaveRequestRef.current += 1;
    personalDefaultSaveAbortRef.current?.abort();
    personalDefaultSaveAbortRef.current = null;
    personalDefaultSavingRef.current = false;
  }, []);

  const closeSettings = () => {
    if (panelBusy) return;
    personalDefaultActiveRef.current = false;
    invalidatePersonalDefaultRequests();
    if (onClose) onClose();
    else window.location.hash = "/chat";
  };

  const signOut = () => {
    personalDefaultActiveRef.current = false;
    invalidatePersonalDefaultRequests();
    clearSession();
    window.location.hash = "/login";
  };

  const changeSection = (next: SettingsSection) => {
    if (panelBusy) return;
    provider.dismissFeedback();
    if (personalDefaultActiveRef.current && next !== "account") {
      personalDefaultActiveRef.current = false;
      invalidatePersonalDefaultRequests();
    }
    setSection(next);
  };

  const saveProviderSettings = async () => {
    if (await provider.save()) void refresh(true);
  };

  const clearProviderApiKey = async () => {
    if (await provider.clearApiKey()) void refresh(true);
  };

  const loadPersonalDefault = useCallback(async () => {
    if (!personalDefaultMountedRef.current || !personalDefaultActiveRef.current) return;
    const requestId = ++personalDefaultLoadRequestRef.current;
    personalDefaultLoadAbortRef.current?.abort();
    personalDefaultSaveRequestRef.current += 1;
    personalDefaultSaveAbortRef.current?.abort();
    personalDefaultSaveAbortRef.current = null;
    personalDefaultSavingRef.current = false;
    const abort = new AbortController();
    personalDefaultLoadAbortRef.current = abort;
    setPersonalDefaultLoading(true);
    setPersonalDefaultSaving(false);
    setPersonalDefaultLoadError(null);
    setPersonalDefaultFeedback(null);
    try {
      const next = await preferencesApi.get(abort.signal);
      if (
        !personalDefaultMountedRef.current ||
        !personalDefaultActiveRef.current ||
        requestId !== personalDefaultLoadRequestRef.current ||
        abort.signal.aborted
      )
        return;
      setPersonalDefault(typeof next.default_chat_model === "string" ? next.default_chat_model : null);
    } catch (failure: unknown) {
      if (
        personalDefaultMountedRef.current &&
        personalDefaultActiveRef.current &&
        requestId === personalDefaultLoadRequestRef.current &&
        !abort.signal.aborted
      ) {
        setPersonalDefaultLoadError(formatApiError(failure, "The personal default model could not be loaded."));
      }
    } finally {
      if (
        personalDefaultMountedRef.current &&
        personalDefaultActiveRef.current &&
        requestId === personalDefaultLoadRequestRef.current &&
        !abort.signal.aborted
      ) {
        personalDefaultLoadAbortRef.current = null;
        setPersonalDefaultLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    personalDefaultMountedRef.current = true;
    return () => {
      personalDefaultMountedRef.current = false;
      personalDefaultActiveRef.current = false;
      invalidatePersonalDefaultRequests();
    };
  }, [invalidatePersonalDefaultRequests]);

  useEffect(() => {
    if (section !== "account") return;
    personalDefaultActiveRef.current = true;
    void loadPersonalDefault();
    return () => {
      personalDefaultActiveRef.current = false;
      invalidatePersonalDefaultRequests();
    };
  }, [section, loadPersonalDefault, invalidatePersonalDefaultRequests]);

  const retryPersonalDefaultLoad = () => {
    void loadPersonalDefault();
  };

  const savePersonalDefault = async (value: string | null) => {
    if (!personalDefaultMountedRef.current || !personalDefaultActiveRef.current || personalDefaultSavingRef.current)
      return;
    const requestId = ++personalDefaultSaveRequestRef.current;
    personalDefaultSaveAbortRef.current?.abort();
    personalDefaultLoadRequestRef.current += 1;
    personalDefaultLoadAbortRef.current?.abort();
    personalDefaultLoadAbortRef.current = null;
    const abort = new AbortController();
    personalDefaultSaveAbortRef.current = abort;
    personalDefaultSavingRef.current = true;
    const previous = personalDefault;
    const targetValue = value;
    setPersonalDefault(value);
    setPersonalDefaultSaving(true);
    setPersonalDefaultFeedback(null);
    try {
      const next = await preferencesApi.set(targetValue, abort.signal);
      if (
        !personalDefaultMountedRef.current ||
        !personalDefaultActiveRef.current ||
        requestId !== personalDefaultSaveRequestRef.current ||
        abort.signal.aborted
      )
        return;
      setPersonalDefault(typeof next.default_chat_model === "string" ? next.default_chat_model : targetValue);
      setPersonalDefaultFeedback({
        kind: "success",
        message:
          targetValue === null
            ? "Personal default cleared. New chats will use the workspace default."
            : "Personal default model saved. New chats will start with it.",
      });
    } catch (failure: unknown) {
      if (
        personalDefaultMountedRef.current &&
        personalDefaultActiveRef.current &&
        requestId === personalDefaultSaveRequestRef.current &&
        !abort.signal.aborted
      ) {
        setPersonalDefault(previous);
        setPersonalDefaultFeedback({
          kind: "error",
          message: formatApiError(failure, "The personal default model could not be saved."),
        });
      }
    } finally {
      if (requestId === personalDefaultSaveRequestRef.current && !abort.signal.aborted) {
        personalDefaultSaveAbortRef.current = null;
        personalDefaultSavingRef.current = false;
        if (personalDefaultMountedRef.current && personalDefaultActiveRef.current) setPersonalDefaultSaving(false);
      }
    }
  };

  const personalModelOptions = catalog?.models ?? [];

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) closeSettings();
      }}
    >
      <DialogContent className="h-[calc(100vh-1rem)] w-[calc(100%-1rem)] max-w-[860px] gap-0 overflow-hidden p-0 shadow-md sm:h-[min(720px,calc(100vh-2rem))] sm:w-[calc(100%-2rem)]">
        <div className="grid h-full min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] md:grid-cols-[210px_minmax(0,1fr)] md:grid-rows-1">
          <aside className="min-w-0 border-b bg-secondary/30 p-3 md:border-b-0 md:border-r md:p-4">
            <div className="px-2 pb-3 pt-1 md:pb-5">
              <DialogTitle className="text-base">Settings</DialogTitle>
              <DialogDescription className="sr-only">
                Review Borealis system status, models, appearance, and account settings.
              </DialogDescription>
            </div>

            <nav
              aria-label="Settings sections"
              className="flex gap-1 overflow-x-auto pb-1 md:grid md:grid-cols-1 md:overflow-visible md:pb-0"
            >
              {SECTIONS.map((item) => {
                const Icon = item.icon;
                const selected = section === item.value;
                return (
                  <button
                    key={item.value}
                    type="button"
                    aria-current={selected ? "page" : undefined}
                    onClick={() => changeSection(item.value)}
                    disabled={panelBusy}
                    className={cn(
                      "flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-3 text-left text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
                      selected
                        ? "bg-accent font-semibold text-foreground"
                        : "text-muted-foreground hover:bg-accent/70 hover:text-foreground",
                    )}
                  >
                    {item.value === "system" ? (
                      <span
                        className={cn(
                          "size-2 shrink-0 rounded-full",
                          !systemHealth.health
                            ? "animate-status-pulse bg-muted-foreground"
                            : systemHealth.health.status === "operational"
                              ? "bg-success"
                              : "bg-warning",
                        )}
                        aria-hidden="true"
                      />
                    ) : (
                      <Icon className={cn("size-4 shrink-0", selected && "text-primary")} />
                    )}
                    <span>{item.label}</span>
                    {((item.value === "provider" && provider.dirtyScopes.connection) ||
                      (item.value === "chat" && provider.dirtyScopes.chat) ||
                      (item.value === "embeddings" && provider.dirtyScopes.embeddings)) && (
                      <span
                        aria-hidden="true"
                        title="Unsaved changes"
                        className="ml-auto size-1.5 shrink-0 rounded-full bg-primary"
                      />
                    )}
                    {item.value === "system" && (
                      <span className="sr-only">
                        {systemHealth.checking && !systemHealth.health
                          ? ", checking"
                          : systemHealth.health?.status === "operational"
                            ? ", ready"
                            : ", attention required"}
                      </span>
                    )}
                  </button>
                );
              })}
            </nav>
          </aside>

          <div key={section} className="min-h-0 min-w-0 overflow-y-auto px-5 py-6 sm:px-7 md:px-8 md:py-7">
            {section === "system" && (
              <section aria-labelledby="settings-system-heading">
                <header className="mb-5 pr-8">
                  <h2 id="settings-system-heading" className="text-xl font-semibold tracking-tight text-foreground">
                    System
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Check the services Borealis needs for chat, analysis, and reports.
                  </p>
                </header>
                <div className="overflow-hidden rounded-lg border">
                  <SystemHealthPanel
                    health={systemHealth.health}
                    checking={systemHealth.checking}
                    error={systemHealth.error}
                    onRefresh={() => {
                      void systemHealth.refresh();
                      void egressAudit.refresh();
                    }}
                    embedded
                  />
                </div>
                {egressAudit.loadError && (
                  <div className="mt-6 rounded-lg border border-destructive/25 bg-destructive/5 p-4" role="alert">
                    <p className="text-sm font-medium">Activity history unavailable</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">{egressAudit.loadError}</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      This history is separate from the service health checks above.
                      {egressAudit.events.length > 0 && " Entries below are from the last successful refresh."} Borealis
                      will retry automatically while this panel is visible.
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-3"
                      disabled={egressAudit.loading}
                      onClick={() => void egressAudit.refresh()}
                    >
                      {egressAudit.loading && <LoaderCircle className="animate-spin" />}
                      {egressAudit.loading ? "Retrying…" : "Retry activity history"}
                    </Button>
                  </div>
                )}
                {egressAudit.events.length > 0 && (
                  <section
                    aria-labelledby="settings-egress-audit-heading"
                    className="mt-6 overflow-hidden rounded-lg border"
                  >
                    <div className="border-b bg-secondary/30 px-5 py-4">
                      <h3 id="settings-egress-audit-heading" className="text-sm font-semibold text-foreground">
                        Egress audit
                      </h3>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Best-effort activity receipts for remote-capable work: what kind, which endpoint host, when.
                        They do not prove that bytes reached the provider, and nothing here contains prompts or data.
                      </p>
                    </div>
                    <ol className="divide-y">
                      {egressAudit.events.map((event) => (
                        <li
                          key={event.id}
                          className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5 text-xs"
                        >
                          <span className="font-medium text-foreground">
                            {event.kind === "consent_acknowledged"
                              ? "Consent acknowledged"
                              : event.kind === "remote_turn"
                                ? "Chat turn"
                                : "Ingestion"}
                          </span>
                          <span className="font-mono text-muted-foreground">{event.endpoint_host ?? "—"}</span>
                          <time dateTime={event.created_at} className="text-muted-foreground">
                            {formatDate(event.created_at)}
                          </time>
                        </li>
                      ))}
                    </ol>
                  </section>
                )}
              </section>
            )}

            {providerPanel && (
              <section aria-labelledby="settings-models-heading">
                <header className="flex flex-col gap-4 border-b pb-5 pr-8 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h2 id="settings-models-heading" className="text-xl font-semibold tracking-tight text-foreground">
                      {activePanel.title}
                    </h2>
                    <p className="mt-1 text-sm text-muted-foreground">{activePanel.description}</p>
                  </div>
                  {section !== "provider" && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void refresh(true)}
                      disabled={loading}
                      aria-label="Refresh models"
                    >
                      <RefreshCw className={cn(loading && "animate-spin")} />
                      {loading ? "Refreshing…" : "Refresh"}
                    </Button>
                  )}
                </header>

                <div className="py-5">
                  {provider.loading && !provider.settings ? (
                    <div className="space-y-3 rounded-lg border bg-card p-4" aria-label="Loading provider settings">
                      <div className="h-9 animate-pulse rounded-md bg-secondary" />
                      <div className="h-9 animate-pulse rounded-md bg-secondary" />
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="h-9 animate-pulse rounded-md bg-secondary" />
                        <div className="h-9 animate-pulse rounded-md bg-secondary" />
                      </div>
                    </div>
                  ) : provider.loadError && !provider.settings ? (
                    <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4" role="alert">
                      <p className="text-sm text-destructive">{provider.loadError}</p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="mt-3"
                        onClick={() => void provider.reload()}
                      >
                        <RefreshCw /> Try again
                      </Button>
                    </div>
                  ) : provider.settings ? (
                    <form
                      className="overflow-hidden rounded-lg border bg-card"
                      aria-labelledby="settings-models-heading"
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (section === "embeddings") void saveEmbeddingSettings();
                        else void saveProviderSettings();
                      }}
                    >
                      <div className="grid gap-x-4 gap-y-5 p-4 sm:grid-cols-2">
                        {section === "provider" && (
                          <>
                            <div className="sm:col-span-2">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <Label htmlFor="settings-llm-base-url">Chat endpoint URL</Label>
                                {provider.settings.managed_by_env.llm_base_url && <ManagedByEnvironment />}
                              </div>
                              <Input
                                id="settings-llm-base-url"
                                type="url"
                                inputMode="url"
                                spellCheck={false}
                                required
                                maxLength={2048}
                                className="mt-2 font-mono"
                                value={provider.form.llm_base_url}
                                onChange={(event) => provider.setField("llm_base_url", event.target.value)}
                                disabled={
                                  provider.settings.managed_by_env.llm_base_url ||
                                  provider.action !== null ||
                                  migrationActive
                                }
                                aria-describedby="settings-llm-base-url-help"
                              />
                              <p
                                id="settings-llm-base-url-help"
                                className="mt-1.5 text-xs leading-5 text-muted-foreground"
                              >
                                Borealis adds <code className="font-mono">/v1</code> when it calls this endpoint.
                              </p>
                            </div>

                            <div className="sm:col-span-2">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <Label htmlFor="settings-llm-api-key">API key</Label>
                                {provider.settings.managed_by_env.llm_api_key && <ManagedByEnvironment />}
                              </div>
                              <Input
                                id="settings-llm-api-key"
                                type="password"
                                autoComplete="new-password"
                                maxLength={8192}
                                className="mt-2 font-mono"
                                value={provider.form.llm_api_key}
                                placeholder={
                                  provider.settings.llm_api_key_configured
                                    ? "Configured — leave blank to keep it"
                                    : "Optional for providers that do not require a key"
                                }
                                onChange={(event) => provider.setField("llm_api_key", event.target.value)}
                                disabled={
                                  provider.settings.managed_by_env.llm_api_key ||
                                  provider.action !== null ||
                                  migrationActive
                                }
                                aria-describedby="settings-llm-api-key-help"
                              />
                              <div className="mt-1.5 flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                                <p
                                  id="settings-llm-api-key-help"
                                  className="min-w-0 flex-1 text-xs leading-5 text-muted-foreground"
                                >
                                  {provider.settings.llm_api_key_configured
                                    ? "A key is configured. Leave this blank to keep it unchanged."
                                    : "Leave blank when your local endpoint does not need authentication."}
                                </p>
                                {provider.settings.llm_api_key_configured &&
                                  !provider.settings.managed_by_env.llm_api_key && (
                                    <Button
                                      type="button"
                                      variant="link"
                                      size="sm"
                                      className="h-5 shrink-0 px-0 py-0 text-xs text-destructive hover:text-destructive"
                                      onClick={() => void clearProviderApiKey()}
                                      disabled={provider.action !== null || migrationActive}
                                      aria-describedby="settings-llm-api-key-help"
                                    >
                                      {provider.action === "clearing-key" && <LoaderCircle className="animate-spin" />}
                                      {provider.action === "clearing-key" ? "Clearing…" : "Clear saved key"}
                                    </Button>
                                  )}
                              </div>
                            </div>

                            {provider.remoteEndpoint && (
                              <div className="sm:col-span-2">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <Label htmlFor="settings-lm-studio-base-url">LM Studio URL (optional)</Label>
                                  {provider.settings.managed_by_env.lm_studio_base_url && <ManagedByEnvironment />}
                                </div>
                                <Input
                                  id="settings-lm-studio-base-url"
                                  type="url"
                                  inputMode="url"
                                  spellCheck={false}
                                  maxLength={2048}
                                  className="mt-2 font-mono"
                                  value={provider.form.lm_studio_base_url}
                                  placeholder="http://127.0.0.1:1234"
                                  onChange={(event) => provider.setField("lm_studio_base_url", event.target.value)}
                                  disabled={
                                    provider.settings.managed_by_env.lm_studio_base_url || provider.action !== null
                                  }
                                  aria-describedby="settings-lm-studio-base-url-help"
                                />
                                <p
                                  id="settings-lm-studio-base-url-help"
                                  className="mt-1.5 text-xs leading-5 text-muted-foreground"
                                >
                                  Used only for the separate local-runtime health check.
                                </p>
                              </div>
                            )}
                          </>
                        )}
                        {section === "chat" && (
                          <div className="min-w-0 sm:col-span-2">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <Label htmlFor="settings-default-chat-model">Default chat model</Label>
                              {provider.settings.managed_by_env.default_chat_model && <ManagedByEnvironment />}
                            </div>
                            <select
                              id="settings-default-chat-model"
                              required
                              className="mt-2 h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm"
                              value={
                                (catalog?.models ?? []).some((model) => model.id === provider.form.default_chat_model)
                                  ? provider.form.default_chat_model
                                  : ""
                              }
                              onChange={(event) => provider.setField("default_chat_model", event.target.value)}
                              disabled={
                                provider.settings.managed_by_env.default_chat_model ||
                                provider.action !== null ||
                                migrationActive ||
                                providerConnectionChanged ||
                                loading ||
                                !discoveryLive
                              }
                            >
                              <option value="" disabled>
                                Choose a chat model
                              </option>
                              {(catalog?.models ?? []).map((model) => (
                                <option key={model.id} value={model.id}>
                                  {model.display_name ?? model.id}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}
                        {section === "embeddings" && (
                          <div className="min-w-0 sm:col-span-2">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <Label htmlFor="settings-default-embed-model">Embedding model</Label>
                              {provider.settings.managed_by_env.default_embed_model && <ManagedByEnvironment />}
                            </div>
                            <select
                              id="settings-default-embed-model"
                              required
                              className="mt-2 h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm"
                              value={
                                availableModels.some((model) => model.id === provider.form.default_embed_model)
                                  ? provider.form.default_embed_model
                                  : ""
                              }
                              onChange={(event) => provider.setField("default_embed_model", event.target.value)}
                              disabled={
                                provider.settings.managed_by_env.default_embed_model ||
                                provider.action !== null ||
                                migrationActive ||
                                providerConnectionChanged ||
                                loading ||
                                !discoveryLive
                              }
                            >
                              <option value="" disabled>
                                Choose an embedding model
                              </option>
                              {(catalog?.available_models ?? []).map((model) => (
                                <option key={model.id} value={model.id}>
                                  {model.display_name ?? model.id}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}
                        {section !== "provider" && (
                          <div className="space-y-2 text-xs leading-5 text-muted-foreground sm:col-span-2">
                            {providerConnectionChanged ? (
                              <p>
                                Save or discard your Provider changes before choosing a model.{" "}
                                <button
                                  type="button"
                                  className="underline text-primary"
                                  onClick={() => changeSection("provider")}
                                >
                                  Open Provider
                                </button>
                              </p>
                            ) : loading ? (
                              <p>Loading available models…</p>
                            ) : !discoveryLive || error ? (
                              <p role="alert">
                                {error ??
                                  "Model discovery is unavailable. Check the provider connection, then refresh."}
                              </p>
                            ) : catalog?.models.length === 0 && section === "chat" ? (
                              <p>No chat models advertised. Check your provider, then refresh.</p>
                            ) : null}
                            {section === "chat" && (
                              <p>
                                This default applies to everyone in the workspace. Your personal override is in{" "}
                                <button
                                  type="button"
                                  className="underline text-primary"
                                  onClick={() => changeSection("account")}
                                >
                                  Account
                                </button>
                                .
                              </p>
                            )}
                          </div>
                        )}
                        {section === "embeddings" && (
                          <p className="text-xs leading-5 text-muted-foreground sm:col-span-2">
                            Borealis detects the model’s search settings automatically. No technical setup is needed.
                            {provider.settings.managed_by_env.embedding_dimension &&
                              " The workspace dimension is managed by your administrator."}
                          </p>
                        )}
                        {section !== "chat" && (
                          <div
                            className={cn(
                              "flex gap-3 rounded-md border px-3 py-2.5 sm:col-span-2",
                              provider.remoteEndpoint
                                ? "border-warning/30 bg-warning/10"
                                : "border-border bg-secondary/35",
                            )}
                          >
                            <Cloud
                              className={cn(
                                "mt-0.5 size-4 shrink-0",
                                provider.remoteEndpoint ? "text-warning" : "text-muted-foreground",
                              )}
                              aria-hidden="true"
                            />
                            <p className="text-xs leading-5 text-muted-foreground">
                              Remote providers receive the {EGRESS_PAYLOAD_CLASSES} under that provider's data policy.
                              Parsing, SQL, storage, and report rendering stay on this machine. Review the provider's
                              data policy before saving.
                            </p>
                          </div>
                        )}
                        {section === "embeddings" && provider.hasNonEmbeddingChanges && (
                          <p className="rounded-md border border-warning/30 bg-warning/10 p-3 text-xs leading-5 sm:col-span-2">
                            Save or discard changes in{" "}
                            <button
                              type="button"
                              className="underline text-primary"
                              onClick={() => changeSection("provider")}
                            >
                              Provider
                            </button>{" "}
                            and{" "}
                            <button
                              type="button"
                              className="underline text-primary"
                              onClick={() => changeSection("chat")}
                            >
                              Chat models
                            </button>{" "}
                            before qualifying an embedding model.
                          </p>
                        )}
                        {section === "embeddings" && (
                          <section
                            aria-labelledby="model-qualification-heading"
                            className="space-y-3 border-t pt-4 sm:col-span-2"
                          >
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                              <div>
                                <h4 id="model-qualification-heading" className="text-sm font-semibold text-foreground">
                                  Check compatibility
                                </h4>
                                <p className="mt-1 max-w-prose text-xs leading-5 text-muted-foreground">
                                  Tests the embedding model and detects its settings, then checks chat compatibility. A
                                  local model may need time to load; allow up to one minute.
                                </p>
                              </div>
                              <Button
                                type="button"
                                variant="outline"
                                className="shrink-0"
                                onClick={() => void provider.qualifyModelPair()}
                                disabled={
                                  provider.action !== null ||
                                  migrationActive ||
                                  provider.hasNonEmbeddingChanges ||
                                  Boolean(
                                    provider.qualificationRemoteOrigin && !provider.qualificationRemoteAcknowledged,
                                  )
                                }
                              >
                                {provider.action === "qualifying" ? (
                                  <LoaderCircle className="animate-spin" />
                                ) : (
                                  <FlaskConical />
                                )}
                                {provider.action === "qualifying" ? "Checking model…" : "Check model"}
                              </Button>
                            </div>

                            {provider.qualificationRemoteOrigin && (
                              <label className="flex cursor-pointer items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
                                <input
                                  type="checkbox"
                                  className="mt-1 size-4 shrink-0 accent-primary"
                                  checked={provider.qualificationRemoteAcknowledged}
                                  onChange={(event) =>
                                    provider.setQualificationRemoteAcknowledged(event.target.checked)
                                  }
                                  disabled={provider.action !== null || migrationActive}
                                />
                                <span>
                                  I understand that qualification sends synthetic test inputs to the exact remote origin{" "}
                                  <code className="break-all font-mono text-foreground">
                                    {provider.qualificationRemoteOrigin}
                                  </code>
                                  .
                                </span>
                              </label>
                            )}

                            {provider.qualification && (
                              <dl className="grid gap-2 sm:grid-cols-2" aria-label="Model qualification results">
                                <div className="rounded-md border bg-secondary/30 px-3 py-2.5">
                                  <dt className="text-xs font-medium text-foreground">Chat compatibility</dt>
                                  <dd
                                    className={cn(
                                      "mt-1 text-xs",
                                      provider.qualification.chat.qualified ? "text-success" : "text-destructive",
                                    )}
                                  >
                                    {qualificationReason(provider.qualification.chat.reason_code)} ·{" "}
                                    {provider.qualification.chat.qualified
                                      ? "Chat tools supported"
                                      : "Open Chat models to review your selection."}
                                  </dd>
                                </div>
                                <div className="rounded-md border bg-secondary/30 px-3 py-2.5">
                                  <dt className="text-xs font-medium text-foreground">Embedding model</dt>
                                  <dd
                                    className={cn(
                                      "mt-1 text-xs",
                                      provider.qualification.embedding.qualified ? "text-success" : "text-destructive",
                                    )}
                                  >
                                    {qualificationReason(provider.qualification.embedding.reason_code)} ·{" "}
                                    {provider.qualification.embedding.qualified
                                      ? "Search settings detected automatically"
                                      : "Check that an embedding model is loaded in your provider."}
                                  </dd>
                                </div>
                              </dl>
                            )}
                          </section>
                        )}
                      </div>

                      {
                        <div className="sticky bottom-0 z-10 flex flex-col gap-3 border-t bg-card px-4 py-3">
                          <div className="min-h-5 text-xs" aria-live="polite">
                            {provider.feedback && (
                              <p
                                role={provider.feedback.kind === "error" ? "alert" : "status"}
                                className={provider.feedback.kind === "error" ? "text-destructive" : "text-success"}
                              >
                                {provider.feedback.message}
                              </p>
                            )}
                          </div>
                          {section === "embeddings" && (
                            <p className="text-xs leading-5 text-muted-foreground">
                              {embeddingIdentityManaged
                                ? "This embedding configuration is managed by the environment."
                                : migrationActive
                                  ? "A search rebuild is already in progress. Follow its status below to finish applying the change."
                                  : provider.hasNonEmbeddingChanges
                                    ? "Save or discard your Provider and Chat models changes first."
                                    : !embeddingTargetChanged
                                      ? "Choose a different embedding model to save a change."
                                      : !provider.qualificationReady
                                        ? "Check the selected model first, then save and rebuild search."
                                        : "Saving rebuilds the search index. After it finishes, apply the change to activate the new model without restarting."}
                            </p>
                          )}
                          <div className="flex flex-wrap justify-end gap-2">
                            {section === "provider" && (
                              <Button
                                type="button"
                                variant="outline"
                                onClick={() => void provider.testConnection()}
                                disabled={provider.action !== null}
                              >
                                {provider.action === "testing" ? (
                                  <LoaderCircle className="animate-spin" />
                                ) : (
                                  <FlaskConical />
                                )}
                                {provider.action === "testing" ? "Testing…" : "Test connection"}
                              </Button>
                            )}
                            {provider.hasChanges && (
                              <Button
                                type="button"
                                variant="ghost"
                                onClick={provider.discardChanges}
                                disabled={panelBusy}
                              >
                                Discard changes
                              </Button>
                            )}
                            {section === "embeddings" && (
                              <Button type="submit" disabled={!canStartMigration}>
                                {migration.action === "starting" ? <LoaderCircle className="animate-spin" /> : <Save />}
                                {migration.action === "starting" ? "Starting rebuild…" : "Save and rebuild search"}
                              </Button>
                            )}
                            {section !== "embeddings" && (
                              <Button
                                type="submit"
                                disabled={provider.action !== null || !provider.hasChanges || migrationActive}
                              >
                                {provider.action === "saving" ? <LoaderCircle className="animate-spin" /> : <Save />}
                                {provider.action === "saving" ? "Saving…" : "Save changes"}
                              </Button>
                            )}
                          </div>
                        </div>
                      }
                    </form>
                  ) : null}
                </div>

                {section === "embeddings" && (
                  <section
                    ref={migrationDetailsRef}
                    aria-labelledby="embedding-migration-heading"
                    className="scroll-mt-4 border-b py-5"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="flex min-w-0 items-start gap-3">
                        <HardDrive className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                        <div>
                          <h3 id="embedding-migration-heading" className="text-sm font-semibold text-foreground">
                            Embedding index migration
                          </h3>
                          <p className="mt-1 max-w-prose text-xs leading-5 text-muted-foreground">
                            Build a verified replacement index before changing an embedding model or dimension. Source
                            changes pause during the build; the current index stays active until you apply the change.
                          </p>
                        </div>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => void migration.refresh()}
                        disabled={migration.checking || migration.action !== null}
                        aria-label="Refresh embedding migration status"
                      >
                        <RefreshCw className={cn(migration.checking && "animate-spin")} />
                        Refresh
                      </Button>
                    </div>

                    {migration.loadError && (
                      <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 p-3" role="alert">
                        <p className="text-sm font-medium">Migration status unavailable</p>
                        <p className="mt-1 text-xs leading-5">{migration.loadError}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {migration.status ? "The status below is from the last successful check. " : ""}
                          Borealis will retry automatically while this panel is visible.
                        </p>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="mt-2"
                          disabled={migration.checking || migration.action !== null}
                          onClick={() => void migration.refresh()}
                        >
                          Retry status check
                        </Button>
                      </div>
                    )}
                    {!migration.status ? (
                      migration.loadError ? null : (
                        <div
                          className="mt-3 h-20 animate-pulse rounded-md bg-secondary"
                          aria-label="Loading migration status"
                        />
                      )
                    ) : (
                      <div className="mt-3 rounded-lg border bg-card p-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span
                            className={cn(
                              "rounded-md border px-2 py-0.5 text-xs font-medium",
                              migration.status.phase === "failed"
                                ? "border-destructive/30 bg-destructive/10 text-destructive"
                                : migration.status.phase === "ready_to_apply" || migration.status.restart_required
                                  ? "border-warning/30 bg-warning/10 text-warning"
                                  : migration.status.phase === "idle"
                                    ? "bg-secondary text-muted-foreground"
                                    : "border-primary/30 bg-primary/10 text-primary",
                            )}
                          >
                            {migration.loadError && "Last known: "}
                            {migrationPhaseLabel(migration.status.phase)}
                          </span>
                          {migration.status.target_model && migration.status.target_dimension && (
                            <code className="max-w-full break-all font-mono text-xs text-muted-foreground">
                              {migration.status.target_model} · {migration.status.target_dimension}d
                            </code>
                          )}
                        </div>

                        {(migration.status.phase === "snapshotting" || migration.status.phase === "building") && (
                          <div className="mt-4">
                            <div className="mb-1.5 flex justify-between gap-3 text-xs text-muted-foreground">
                              <span>
                                {migration.status.phase === "snapshotting"
                                  ? "Preparing a stable source snapshot"
                                  : `${migration.status.indexed_count.toLocaleString()} of ${migration.status.chunk_count.toLocaleString()} chunks`}
                              </span>
                              {migration.status.phase === "building" && <span>{migrationProgress}%</span>}
                            </div>
                            <progress
                              className="h-2 w-full accent-primary"
                              max={Math.max(1, migration.status.chunk_count)}
                              value={migration.status.indexed_count}
                              aria-label="Embedding migration progress"
                            />
                            <p className="mt-1.5 text-xs text-muted-foreground">
                              {migration.status.source_count.toLocaleString()} source
                              {migration.status.source_count === 1 ? "" : "s"} in the immutable snapshot.
                            </p>
                          </div>
                        )}

                        {migration.status.phase === "idle" && (
                          <p className="mt-3 text-xs leading-5 text-muted-foreground">
                            {embeddingIdentityManaged
                              ? "The embedding identity is managed by the environment and cannot be migrated here."
                              : !embeddingTargetChanged
                                ? "Choose a different embedding model above, then check it before rebuilding search."
                                : provider.hasNonEmbeddingChanges
                                  ? "Save or revert endpoint, API key, chat-model, and health-probe changes separately before starting this migration."
                                  : !provider.qualificationReady
                                    ? "Check the selected model before rebuilding search."
                                    : "The exact target passed qualification and is ready to build."}
                          </p>
                        )}

                        {migration.status.phase === "ready_to_apply" && (
                          <div className="mt-3 rounded-md border border-warning/30 bg-warning/10 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
                            The replacement index is complete and verified. Apply it now without restarting. Borealis
                            waits for active chats to finish, switches search indexes, then resumes automatically.
                          </div>
                        )}

                        {migration.status.phase === "apply_pending" && (
                          <div className="mt-3 rounded-md border border-warning/30 bg-warning/10 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
                            Waiting for active chats to finish, then switching to the verified search index. Keep using
                            Borealis; no restart is needed.
                          </div>
                        )}

                        {migration.status.error_code && (
                          <p className="mt-3 text-xs leading-5 text-destructive" role="alert">
                            {embeddingMigrationErrorMessage(migration.status.error_code)}
                          </p>
                        )}

                        {migration.feedback && (
                          <p
                            className={cn(
                              "mt-3 text-xs",
                              migration.feedback?.kind === "success" ? "text-success" : "text-destructive",
                            )}
                            role={migration.feedback?.kind === "error" ? "alert" : "status"}
                          >
                            {migration.feedback?.message}
                          </p>
                        )}

                        <div className="mt-4 flex flex-wrap gap-2">
                          {migration.status.can_retry && (
                            <Button
                              type="button"
                              onClick={() => void migration.retry()}
                              disabled={
                                Boolean(migration.loadError) || migration.action !== null || provider.action !== null
                              }
                            >
                              {migration.action === "retrying" && <LoaderCircle className="animate-spin" />}
                              {migration.action === "retrying" ? "Retrying…" : "Retry migration"}
                            </Button>
                          )}
                          {migration.status.can_apply && (
                            <Button
                              type="button"
                              onClick={() => void migration.apply()}
                              disabled={
                                Boolean(migration.loadError) || migration.action !== null || provider.action !== null
                              }
                            >
                              {migration.action === "applying" && <LoaderCircle className="animate-spin" />}
                              {migration.action === "applying" ? "Applying…" : "Apply now"}
                            </Button>
                          )}
                          {migration.status.can_cancel && (
                            <Button
                              type="button"
                              variant="outline"
                              onClick={() => void migration.cancel()}
                              disabled={
                                Boolean(migration.loadError) || migration.action !== null || provider.action !== null
                              }
                            >
                              {migration.action === "cancelling" && <LoaderCircle className="animate-spin" />}
                              {migration.action === "cancelling" ? "Cancelling…" : "Cancel migration"}
                            </Button>
                          )}
                        </div>
                      </div>
                    )}
                  </section>
                )}
              </section>
            )}

            {section === "engine" && <ContainedPanel standalone />}

            {section === "appearance" && (
              <section aria-labelledby="settings-appearance-heading">
                <header className="border-b pb-5 pr-8">
                  <h2 id="settings-appearance-heading" className="text-xl font-semibold tracking-tight text-foreground">
                    Appearance
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Choose how Borealis looks on this device.
                    {theme === "system" && ` System currently uses ${resolvedTheme} mode.`}
                  </p>
                </header>
                <div className="grid gap-3 py-5 sm:grid-cols-3">
                  {APPEARANCE_OPTIONS.map((option) => {
                    const Icon = option.icon;
                    const selected = option.value === theme;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => setTheme(option.value)}
                        className={cn(
                          "rounded-md border-2 p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                          selected
                            ? "border-primary bg-primary/5"
                            : "border-border bg-background hover:border-primary/40 hover:bg-secondary/40",
                        )}
                      >
                        <span className="flex items-center justify-between gap-2">
                          <Icon className={cn("size-4", selected ? "text-primary" : "text-muted-foreground")} />
                          {selected && <Check className="size-4 text-primary" />}
                        </span>
                        <span className="mt-3 block text-sm font-medium text-foreground">{option.label}</span>
                        <span className="mt-1 block text-xs leading-5 text-muted-foreground">{option.description}</span>
                      </button>
                    );
                  })}
                </div>
              </section>
            )}

            {section === "account" && (
              <section aria-labelledby="settings-account-heading">
                <header className="border-b pb-5 pr-8">
                  <h2 id="settings-account-heading" className="text-xl font-semibold tracking-tight text-foreground">
                    Account
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    View the signed-in account, choose a personal default model, or end this session.
                  </p>
                </header>
                <div className="flex flex-col gap-5 py-5 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">
                      {user?.email?.slice(0, 2).toUpperCase() ?? "B"}
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Signed in as</p>
                      <p className="mt-1 break-words text-sm font-medium text-foreground">
                        {user?.email ?? "Email unavailable"}
                      </p>
                    </div>
                  </div>
                  {desktopWorkspace ? (
                    <p className="max-w-64 text-right text-xs leading-5 text-muted-foreground">
                      Local desktop workspace. Reopen Borealis to renew this session.
                    </p>
                  ) : (
                    <Button type="button" variant="outline" onClick={signOut}>
                      <LogOut /> Sign out
                    </Button>
                  )}
                </div>
                <div className="border-t py-5">
                  <h3 className="text-sm font-semibold text-foreground">Personal default model</h3>
                  <p className="mt-1 max-w-prose text-xs leading-5 text-muted-foreground">
                    New chats start with this model instead of the workspace default. Existing chats keep their own
                    model.
                  </p>
                  {personalDefaultLoading ? (
                    <div
                      className="mt-3 h-9 w-full max-w-xs animate-pulse rounded-md bg-secondary"
                      aria-label="Loading personal default model"
                    />
                  ) : personalDefaultLoadError ? (
                    <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4" role="alert">
                      <p className="text-sm text-destructive">{personalDefaultLoadError}</p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="mt-3"
                        onClick={retryPersonalDefaultLoad}
                      >
                        <RefreshCw /> Try again
                      </Button>
                    </div>
                  ) : (
                    <div className="mt-3 w-full max-w-xs">
                      <Label htmlFor="settings-personal-default-model">Personal default model</Label>
                      <select
                        id="settings-personal-default-model"
                        value={
                          personalModelOptions.some((option) => option.id === personalDefault)
                            ? (personalDefault ?? "")
                            : ""
                        }
                        disabled={personalDefaultSaving}
                        aria-busy={personalDefaultSaving}
                        onChange={(event) =>
                          void savePersonalDefault(event.target.value === "" ? null : event.target.value)
                        }
                        className="mt-2 h-9 w-full rounded-md border bg-background px-2 text-sm"
                      >
                        <option value="">Workspace default</option>
                        {personalModelOptions.map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.display_name ?? option.id}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  <div className="mt-2 min-h-5 text-xs" aria-live="polite">
                    {personalDefaultFeedback && (
                      <p
                        role={personalDefaultFeedback.kind === "error" ? "alert" : "status"}
                        className={personalDefaultFeedback.kind === "error" ? "text-destructive" : "text-success"}
                      >
                        {personalDefaultFeedback.message}
                      </p>
                    )}
                  </div>
                </div>
              </section>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
