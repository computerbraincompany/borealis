import { MessageSquare, Database, Plug, FileText, Settings2, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { AccountMenu } from "@/components/AccountMenu";

const NAV_ITEMS = [
  { href: "/chat", label: "Chat", icon: MessageSquare },
  { href: "/sources", label: "Sources", icon: Database },
  { href: "/connectors", label: "Connectors", icon: Plug },
  { href: "/reports", label: "Reports", icon: FileText },
  { href: "/settings", label: "Settings", icon: Settings2 },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const active = (window.location.hash || "#/chat").replace(/^#/, "").split("?")[0];

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
                  "group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar",
                  isActive
                    ? "bg-accent font-semibold text-foreground"
                    : "text-muted-foreground hover:bg-accent/70 hover:text-foreground",
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
        <div className="border-t px-2 py-2">
          <AccountMenu />
        </div>
      </aside>

      {/* main */}
      <main className="relative flex-1 overflow-hidden">{children}</main>
    </div>
  );
}
