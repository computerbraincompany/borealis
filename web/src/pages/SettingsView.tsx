import { Check, Cpu, LogOut, Monitor, Moon, RefreshCw, Sun, UserRound } from "lucide-react";
import { useTheme, type ThemeChoice } from "@/components/ThemeProvider";
import { SystemHealthPanel } from "@/components/SystemHealthPanel";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useModelCatalog } from "@/hooks/useModelCatalog";
import { useSystemHealth } from "@/hooks/useSystemHealth";
import { clearSession, getUser } from "@/lib/api";
import { cn } from "@/lib/utils";

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

export function SettingsView() {
  const { catalog, loading, error, refresh } = useModelCatalog();
  const systemHealth = useSystemHealth();
  const { theme, resolvedTheme, setTheme } = useTheme();
  const user = getUser();
  const discoveryLive = catalog?.discovery === "live";

  const signOut = () => {
    clearSession();
    window.location.hash = "/login";
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-10">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Settings</h1>
          <p className="mt-1 text-sm text-muted-foreground">Review service readiness and workspace preferences.</p>
        </div>

        <Tabs defaultValue="system" className="mt-6">
          <TabsList
            aria-label="Settings sections"
            className="grid h-auto w-full grid-cols-2 gap-1 rounded-lg border bg-secondary/35 p-1 md:grid-cols-4"
          >
            <TabsTrigger
              value="system"
              className="h-10 gap-2 border-2 border-transparent px-3 data-[state=active]:border-primary data-[state=active]:shadow-none"
            >
              <span
                className={cn(
                  "size-2 rounded-full",
                  !systemHealth.health
                    ? "animate-status-pulse bg-muted-foreground"
                    : systemHealth.health.status === "operational"
                      ? "bg-success"
                      : "bg-warning",
                )}
                aria-hidden="true"
              />
              System
              <span className="sr-only">
                {systemHealth.checking && !systemHealth.health
                  ? ", checking"
                  : systemHealth.health?.status === "operational"
                    ? ", ready"
                    : ", attention required"}
              </span>
            </TabsTrigger>
            <TabsTrigger
              value="models"
              className="h-10 gap-2 border-2 border-transparent px-3 data-[state=active]:border-primary data-[state=active]:shadow-none"
            >
              <Cpu className="size-4" /> Models
            </TabsTrigger>
            <TabsTrigger
              value="appearance"
              className="h-10 gap-2 border-2 border-transparent px-3 data-[state=active]:border-primary data-[state=active]:shadow-none"
            >
              <Monitor className="size-4" /> Appearance
            </TabsTrigger>
            <TabsTrigger
              value="account"
              className="h-10 gap-2 border-2 border-transparent px-3 data-[state=active]:border-primary data-[state=active]:shadow-none"
            >
              <UserRound className="size-4" /> Account
            </TabsTrigger>
          </TabsList>

          <TabsContent value="system" className="mt-5">
            <SystemHealthPanel
              health={systemHealth.health}
              checking={systemHealth.checking}
              error={systemHealth.error}
              onRefresh={() => void systemHealth.refresh()}
            />
          </TabsContent>

          <TabsContent value="models" className="mt-5">
            <Card className="overflow-hidden rounded-lg shadow-none">
              <section aria-labelledby="models-heading">
                <div className="flex flex-wrap items-start justify-between gap-4 p-5">
                  <div className="flex min-w-0 items-start gap-3">
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-secondary text-primary">
                      <Cpu className="size-4" />
                    </div>
                    <div>
                      <h2 id="models-heading" className="font-semibold text-foreground">
                        Models
                      </h2>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Model selection is saved per chat. New chats start with the configured default.
                      </p>
                    </div>
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
                </div>

                <div className="border-t p-5">
                  <dl className="grid gap-4 sm:grid-cols-2">
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

                  <div className="mt-5">
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
                </div>
              </section>
            </Card>
          </TabsContent>

          <TabsContent value="appearance" className="mt-5">
            <Card className="overflow-hidden rounded-lg shadow-none">
              <section aria-labelledby="appearance-heading">
                <div className="flex items-start gap-3 p-5">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-secondary text-primary">
                    <Monitor className="size-4" />
                  </div>
                  <div>
                    <h2 id="appearance-heading" className="font-semibold text-foreground">
                      Appearance
                    </h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Choose how Borealis looks on this device.
                      {theme === "system" && ` System currently uses ${resolvedTheme} mode.`}
                    </p>
                  </div>
                </div>
                <div className="grid gap-3 border-t p-5 sm:grid-cols-3">
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
            </Card>
          </TabsContent>

          <TabsContent value="account" className="mt-5">
            <Card className="overflow-hidden rounded-lg shadow-none">
              <section aria-labelledby="account-heading">
                <div className="flex items-start gap-3 p-5">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-secondary text-primary">
                    <UserRound className="size-4" />
                  </div>
                  <div>
                    <h2 id="account-heading" className="font-semibold text-foreground">
                      Account
                    </h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      View the signed-in account or end this session.
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-4 border-t p-5">
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Signed in as</p>
                    <p className="mt-1 text-sm font-medium text-foreground">{user?.email ?? "Email unavailable"}</p>
                  </div>
                  <Button type="button" variant="outline" onClick={signOut}>
                    <LogOut /> Sign out
                  </Button>
                </div>
              </section>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
