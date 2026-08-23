import { MessageSquare, Database, Plug, FileText, LogOut, Plus, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getUser, clearSession } from "@/lib/api";
import { ThemeMenu } from "@/components/ThemeMenu";

const NAV_ITEMS = [
  { href: "/chat", label: "Chat", icon: MessageSquare },
  { href: "/sources", label: "Sources", icon: Database },
  { href: "/connectors", label: "Connectors", icon: Plug },
  { href: "/reports", label: "Reports", icon: FileText },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const active = (window.location.hash || "#/chat").replace(/^#/, "");
  const user = getUser();

  const goto = (href: string) => {
    window.location.hash = href;
  };

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* aurora glow top edge */}
      <div className="aurora-top fixed inset-x-0 top-0 z-50 h-[2px] animate-shimmer" />

      {/* sidebar */}
      <aside className="flex w-[232px] shrink-0 flex-col border-r bg-sidebar/90 backdrop-blur">
        {/* brand */}
        <div className="flex items-center gap-2.5 px-5 py-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-aurora-teal to-aurora-violet shadow-lg shadow-aurora-violet/20">
            <Sparkles className="h-5 w-5 text-aurora-foreground" />
          </div>
          <div>
            <div className="text-[15px] font-bold tracking-tight text-foreground">Borealis</div>
            <div className="text-[11px] text-muted-foreground -mt-0.5">ask your data · open source</div>
          </div>
        </div>

        {/* nav */}
        <nav className="mt-2 flex flex-1 flex-col gap-1 px-3">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = active.startsWith(item.href);
            return (
              <button
                key={item.href}
                onClick={() => goto(item.href)}
                className={cn(
                  "group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-gradient-to-r from-aurora-teal/15 to-aurora-violet/15 text-foreground"
                    : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                )}
              >
                <Icon className={cn("h-[18px] w-[18px]", isActive ? "text-aurora-teal" : "text-muted-foreground group-hover:text-foreground")} />
                {item.label}
                {item.href === "/reports" && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-aurora-violet/70" />}
              </button>
            );
          })}
        </nav>

        {/* new chat quick action */}
        <div className="px-3 pb-3">
          <Button onClick={() => (window.location.hash = "/chat")} className="w-full" variant="aurora">
            <Plus className="h-4 w-4" /> New chat
          </Button>
        </div>

        {/* user */}
        <div className="border-t px-3 py-3">
          <div className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-aurora-blue to-aurora-violet text-xs font-bold text-aurora-foreground">
              {user?.email?.slice(0, 2).toUpperCase() ?? "B"}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium text-foreground">{user?.email}</div>
              <div className="text-[11px] text-muted-foreground">Local instance</div>
            </div>
            <div className="flex shrink-0 items-center">
              <ThemeMenu />
              <button
                title="Sign out"
                aria-label="Sign out"
                onClick={() => {
                  clearSession();
                  window.location.hash = "/login";
                }}
                className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-secondary hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      </aside>

      {/* main */}
      <main className="relative flex-1 overflow-hidden">{children}</main>
    </div>
  );
}
