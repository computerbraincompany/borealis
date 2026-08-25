import { MessageSquare, Database, Plug, FileText, LogOut, Settings2, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { getUser, clearSession } from "@/lib/api";
import { ThemeMenu } from "@/components/ThemeMenu";

const NAV_ITEMS = [
  { href: "/chat", label: "Chat", icon: MessageSquare },
  { href: "/sources", label: "Sources", icon: Database },
  { href: "/connectors", label: "Connectors", icon: Plug },
  { href: "/reports", label: "Reports", icon: FileText },
  { href: "/settings", label: "Settings", icon: Settings2 },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const active = (window.location.hash || "#/chat").replace(/^#/, "").split("?")[0];
  const user = getUser();

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* sidebar */}
      <aside className="flex w-[232px] shrink-0 flex-col border-r bg-sidebar">
        {/* brand */}
        <div className="flex items-center gap-2.5 px-5 py-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
            <Sparkles className="h-5 w-5" />
          </div>
          <div>
            <div className="text-[15px] font-bold tracking-tight text-foreground">Borealis</div>
            <div className="-mt-0.5 text-[11px] text-muted-foreground">AI data workspace</div>
          </div>
        </div>

        {/* nav */}
        <nav className="mt-2 flex flex-1 flex-col gap-1 px-3">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = active === item.href || active.startsWith(`${item.href}/`);
            return (
              <a
                key={item.href}
                href={`#${item.href}`}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "group flex items-center gap-3 rounded-md border-l-2 px-3 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar",
                  isActive
                    ? "border-primary bg-secondary text-foreground"
                    : "border-transparent text-muted-foreground hover:bg-secondary hover:text-foreground",
                )}
              >
                <Icon
                  className={cn(
                    "h-[18px] w-[18px]",
                    isActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground",
                  )}
                />
                {item.label}
              </a>
            );
          })}
        </nav>

        {/* user */}
        <div className="border-t px-3 py-3">
          <div className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
              {user?.email?.slice(0, 2).toUpperCase() ?? "B"}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium text-foreground">{user?.email}</div>
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
