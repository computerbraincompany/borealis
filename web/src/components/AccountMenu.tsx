import { ChevronUp, LogOut, Monitor, Moon, Settings2, Sun, SunMoon } from "lucide-react";
import { clearSession, getUser } from "@/lib/api";
import { hasDesktopBridge } from "@/lib/desktopBootstrap";
import { useTheme, type ThemeChoice } from "@/components/ThemeProvider";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const THEME_OPTIONS: Array<{
  value: ThemeChoice;
  label: string;
  description: string;
  icon: typeof Sun;
}> = [
  { value: "light", label: "Light", description: "Always use light", icon: Sun },
  { value: "dark", label: "Dark", description: "Always use dark", icon: Moon },
  { value: "system", label: "System", description: "Match this device", icon: Monitor },
];

export function AccountMenu() {
  const user = getUser();
  const email = user?.email || "Account";
  const initials = email.slice(0, 2).toLocaleUpperCase();
  const { theme, resolvedTheme, setTheme } = useTheme();
  const themeLabel = THEME_OPTIONS.find((option) => option.value === theme)?.label ?? "System";
  const desktopWorkspace = hasDesktopBridge();

  const signOut = () => {
    clearSession();
    window.location.hash = "/login";
  };

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Account menu for ${email}`}
          title={email}
          className="group/account flex w-full min-w-0 items-center gap-2.5 rounded-lg border border-transparent px-2.5 py-2 text-left outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:border-border data-[state=open]:bg-secondary"
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-bold text-primary">
            {initials}
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">{email}</span>
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors group-hover/account:text-foreground group-data-[state=open]/account:bg-background group-data-[state=open]/account:text-foreground">
            <ChevronUp className="size-3.5" />
          </span>
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={8}
        collisionPadding={12}
        sticky="always"
        className="w-[min(13.5rem,calc(100vw-1.5rem))] rounded-lg p-1.5 shadow-lg"
      >
        <DropdownMenuLabel className="flex items-center gap-2.5 px-2 py-2.5 font-normal">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-bold text-primary">
            {initials}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block break-all text-sm font-medium leading-5 text-foreground">{email}</span>
          </span>
        </DropdownMenuLabel>

        <DropdownMenuSeparator />

        <DropdownMenuItem asChild className="min-h-10 px-2.5">
          <a href="#/settings">
            <Settings2 />
            <span className="flex-1">Settings</span>
          </a>
        </DropdownMenuItem>

        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="min-h-10 px-2.5">
            <SunMoon />
            <span className="flex-1">Appearance</span>
            <span className="text-xs text-muted-foreground">{themeLabel}</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-56 rounded-lg p-1.5" collisionPadding={12}>
            <DropdownMenuLabel>Appearance</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup value={theme}>
              {THEME_OPTIONS.map((option) => {
                const Icon = option.icon;
                const active = option.value === theme;
                return (
                  <DropdownMenuRadioItem
                    key={option.value}
                    value={option.value}
                    onSelect={() => setTheme(option.value)}
                    className={active ? "bg-accent font-medium" : undefined}
                  >
                    <Icon className="mr-2 size-4" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="text-foreground">{option.label}</span>
                      <span className="text-[11px] text-muted-foreground">
                        {option.value === "system"
                          ? `${option.description} · currently ${resolvedTheme}`
                          : option.description}
                      </span>
                    </span>
                  </DropdownMenuRadioItem>
                );
              })}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        {!desktopWorkspace && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={signOut}
              className="min-h-10 px-2.5 text-destructive focus:bg-destructive/10 focus:text-destructive [&_svg]:text-destructive"
            >
              <LogOut />
              <span className="flex-1">Sign out</span>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
