import { useState } from "react";
import { Activity, Check, Cpu, LogOut, Monitor, Moon, RefreshCw, Sun, UserRound } from "lucide-react";
import { useTheme, type ThemeChoice } from "@/components/ThemeProvider";
import { SystemHealthPanel } from "@/components/SystemHealthPanel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useModelCatalog } from "@/hooks/useModelCatalog";
import { useSystemHealth } from "@/hooks/useSystemHealth";
import { clearSession, getUser } from "@/lib/api";
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

export function SettingsView({ onClose }: SettingsViewProps) {
  const [section, setSection] = useState<SettingsSection>("system");
  const { catalog, loading, error, refresh } = useModelCatalog();
  const systemHealth = useSystemHealth();
  const { theme, resolvedTheme, setTheme } = useTheme();
  const user = getUser();
  const discoveryLive = catalog?.discovery === "live";

  const closeSettings = () => {
    if (onClose) onClose();
    else window.location.hash = "/chat";
  };

  const signOut = () => {
    clearSession();
    window.location.hash = "/login";
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
                      "flex h-10 items-center gap-2 rounded-md border-l-2 px-3 text-left text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      selected
                        ? "border-primary bg-secondary text-foreground"
                        : "border-transparent text-muted-foreground hover:bg-secondary/70 hover:text-foreground",
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
                      <Icon className="size-4 shrink-0" />
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
                  <Button type="button" variant="outline" onClick={signOut}>
                    <LogOut /> Sign out
                  </Button>
                </div>
              </section>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
