import { useState } from "react";
import {
  Activity,
  Check,
  Cloud,
  Cpu,
  FlaskConical,
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
import { SystemHealthPanel } from "@/components/SystemHealthPanel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useModelCatalog } from "@/hooks/useModelCatalog";
import { useProviderSettings } from "@/hooks/useProviderSettings";
import { useSystemHealth } from "@/hooks/useSystemHealth";
import { clearSession, getUser } from "@/lib/api";
import { hasDesktopBridge } from "@/lib/desktopBootstrap";
import { cn } from "@/lib/utils";

type SettingsSection = "system" | "models" | "appearance" | "account";

const SECTIONS: Array<{ value: SettingsSection; label: string; icon: typeof Activity }> = [
  { value: "system", label: "System", icon: Activity },
  { value: "models", label: "Models", icon: Cpu },
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

function ManagedByEnvironment() {
  return (
    <span className="rounded border bg-secondary px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      Managed by environment
    </span>
  );
}

export function SettingsView({ onClose }: SettingsViewProps) {
  const [section, setSection] = useState<SettingsSection>("system");
  const { catalog, loading, error, refresh } = useModelCatalog();
  const provider = useProviderSettings();
  const systemHealth = useSystemHealth();
  const { theme, resolvedTheme, setTheme } = useTheme();
  const user = getUser();
  const desktopWorkspace = hasDesktopBridge();
  const discoveryLive = catalog?.discovery === "live";

  const closeSettings = () => {
    if (onClose) onClose();
    else window.location.hash = "/chat";
  };

  const signOut = () => {
    clearSession();
    window.location.hash = "/login";
  };

  const saveProviderSettings = async () => {
    if (await provider.save()) void refresh(true);
  };

  const clearProviderApiKey = async () => {
    if (await provider.clearApiKey()) void refresh(true);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) closeSettings();
      }}
    >
      <DialogContent className="h-[calc(100vh-1rem)] w-[calc(100%-1rem)] max-w-[860px] gap-0 overflow-hidden p-0 shadow-md sm:h-[min(720px,calc(100vh-2rem))] sm:w-[calc(100%-2rem)]">
        <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] md:grid-cols-[210px_minmax(0,1fr)] md:grid-rows-1">
          <aside className="border-b bg-secondary/30 p-3 md:border-b-0 md:border-r md:p-4">
            <div className="px-2 pb-3 pt-1 md:pb-5">
              <DialogTitle className="text-base">Settings</DialogTitle>
              <DialogDescription className="sr-only">
                Review Borealis system status, models, appearance, and account settings.
              </DialogDescription>
            </div>

            <nav aria-label="Settings sections" className="grid grid-cols-2 gap-1 sm:grid-cols-4 md:grid-cols-1">
              {SECTIONS.map((item) => {
                const Icon = item.icon;
                const selected = section === item.value;
                return (
                  <button
                    key={item.value}
                    type="button"
                    aria-current={selected ? "page" : undefined}
                    onClick={() => setSection(item.value)}
                    className={cn(
                      "flex h-10 items-center gap-2 rounded-lg px-3 text-left text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
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

          <div className="min-h-0 overflow-y-auto px-5 py-6 sm:px-7 md:px-8 md:py-7">
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
                    onRefresh={() => void systemHealth.refresh()}
                    embedded
                  />
                </div>
              </section>
            )}

            {section === "models" && (
              <section aria-labelledby="settings-models-heading">
                <header className="flex flex-col gap-4 border-b pb-5 pr-8 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h2 id="settings-models-heading" className="text-xl font-semibold tracking-tight text-foreground">
                      Models
                    </h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Selection is saved per chat. New chats use the configured default.
                    </p>
                  </div>
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
                </header>

                <div className="border-b py-5">
                  <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <h3 id="provider-connection-heading" className="text-sm font-semibold text-foreground">
                        Provider connection
                      </h3>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        Connect Borealis to LM Studio or another OpenAI-compatible provider.
                      </p>
                    </div>
                    <span className="rounded-md border bg-secondary/60 px-2 py-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                      OpenAI-compatible
                    </span>
                  </div>

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
                      aria-labelledby="provider-connection-heading"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void saveProviderSettings();
                      }}
                    >
                      <div className="grid gap-x-4 gap-y-5 p-4 sm:grid-cols-2">
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
                            disabled={provider.settings.managed_by_env.llm_base_url || provider.action !== null}
                            aria-describedby="settings-llm-base-url-help"
                          />
                          <p id="settings-llm-base-url-help" className="mt-1.5 text-xs leading-5 text-muted-foreground">
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
                            disabled={provider.settings.managed_by_env.llm_api_key || provider.action !== null}
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
                                  disabled={provider.action !== null}
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
                              disabled={provider.settings.managed_by_env.lm_studio_base_url || provider.action !== null}
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

                        <div>
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <Label htmlFor="settings-default-chat-model">Default chat model</Label>
                            {provider.settings.managed_by_env.default_chat_model && <ManagedByEnvironment />}
                          </div>
                          <Input
                            id="settings-default-chat-model"
                            required
                            maxLength={256}
                            spellCheck={false}
                            className="mt-2 font-mono"
                            value={provider.form.default_chat_model}
                            onChange={(event) => provider.setField("default_chat_model", event.target.value)}
                            disabled={provider.settings.managed_by_env.default_chat_model || provider.action !== null}
                          />
                        </div>

                        <div>
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <Label htmlFor="settings-default-embed-model">Embedding model</Label>
                            {provider.settings.managed_by_env.default_embed_model && <ManagedByEnvironment />}
                          </div>
                          <Input
                            id="settings-default-embed-model"
                            required
                            maxLength={256}
                            spellCheck={false}
                            className="mt-2 font-mono"
                            value={provider.form.default_embed_model}
                            onChange={(event) => provider.setField("default_embed_model", event.target.value)}
                            disabled={provider.settings.managed_by_env.default_embed_model || provider.action !== null}
                          />
                        </div>

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
                            Remote providers receive your prompts and any retrieved document or data context needed to
                            answer them. Review the provider’s data policy before saving.
                          </p>
                        </div>
                      </div>

                      <div className="flex flex-col gap-3 border-t bg-secondary/20 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
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
                        <div className="flex shrink-0 flex-wrap gap-2">
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
                          <Button type="submit" disabled={provider.action !== null || !provider.hasChanges}>
                            {provider.action === "saving" ? <LoaderCircle className="animate-spin" /> : <Save />}
                            {provider.action === "saving" ? "Saving…" : "Save changes"}
                          </Button>
                        </div>
                      </div>
                    </form>
                  ) : null}
                </div>

                <dl className="grid gap-5 border-b py-5 sm:grid-cols-2">
                  <div>
                    <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Configured default
                    </dt>
                    <dd className="mt-1.5 font-mono text-sm text-foreground">
                      {catalog?.default_model ?? (loading ? "Checking…" : "Unavailable")}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Discovery</dt>
                    <dd className="mt-1.5 flex items-center gap-2 text-sm text-foreground" aria-live="polite">
                      <span
                        className={cn(
                          "inline-flex rounded-md border px-2 py-0.5 text-xs font-medium",
                          loading
                            ? "border-border bg-secondary text-secondary-foreground"
                            : discoveryLive
                              ? "border-success/30 bg-success/10 text-success"
                              : "border-warning/30 bg-warning/10 text-warning",
                        )}
                      >
                        {loading ? "Checking" : discoveryLive ? "Live" : "Unavailable"}
                      </span>
                      {!loading && discoveryLive && (
                        <span className="text-muted-foreground">
                          {catalog.models.length} {catalog.models.length === 1 ? "model" : "models"}
                        </span>
                      )}
                    </dd>
                  </div>
                </dl>

                {error && (
                  <div
                    className="mt-5 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                    role="alert"
                  >
                    {catalog && <span className="font-medium">Showing the last available catalog. </span>}
                    {error}
                  </div>
                )}

                <div className="pt-5">
                  <h3 className="text-sm font-medium text-foreground">Available chat models</h3>
                  {loading && !catalog ? (
                    <div className="mt-3 space-y-2" aria-label="Loading model catalog">
                      <div className="h-10 animate-pulse rounded-md bg-secondary" />
                      <div className="h-10 animate-pulse rounded-md bg-secondary" />
                    </div>
                  ) : !catalog ? (
                    <p className="mt-2 rounded-md border bg-secondary/40 px-3 py-3 text-sm text-muted-foreground">
                      Model catalog unavailable. Refresh to try again.
                    </p>
                  ) : catalog.discovery === "unavailable" ? (
                    <p className="mt-2 rounded-md border bg-secondary/40 px-3 py-3 text-sm text-muted-foreground">
                      Model discovery is unavailable. New chats can still use the configured default.
                    </p>
                  ) : catalog.models.length === 0 ? (
                    <p className="mt-2 rounded-md border bg-secondary/40 px-3 py-3 text-sm text-muted-foreground">
                      No chat models advertised.
                    </p>
                  ) : (
                    <ul className="mt-2 divide-y rounded-md border" aria-label="Available chat models">
                      {catalog.models.map((model) => (
                        <li key={model.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
                          <div className="min-w-0">
                            <div className="flex min-w-0 items-center gap-2">
                              <code className="truncate font-mono text-sm text-foreground" title={model.id}>
                                {model.id}
                              </code>
                              {model.id === catalog.default_model && (
                                <span className="rounded border bg-secondary px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                                  Default
                                </span>
                              )}
                            </div>
                            {model.owned_by && (
                              <p className="mt-0.5 text-xs text-muted-foreground">Provider: {model.owned_by}</p>
                            )}
                          </div>
                          {model.id === catalog.default_model && <Check className="size-4 shrink-0 text-primary" />}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </section>
            )}

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
                  <p className="mt-1 text-sm text-muted-foreground">View the signed-in account or end this session.</p>
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
              </section>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
