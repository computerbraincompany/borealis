import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Shell } from "@/components/Shell";
import { LazyLoadBoundary } from "@/components/LazyLoadBoundary";
import { AuthPage } from "@/pages/AuthPage";
import { ChatView } from "@/pages/ChatView";
import { getUser } from "@/lib/api";
import { hasDesktopBridge, initializeDesktopSession } from "@/lib/desktopBootstrap";

const SourcesView = lazy(() => import("@/pages/SourcesView").then((module) => ({ default: module.SourcesView })));
const LibrariesView = lazy(() => import("@/pages/LibrariesView").then((module) => ({ default: module.LibrariesView })));
const AgentsView = lazy(() => import("@/pages/AgentsView").then((module) => ({ default: module.AgentsView })));
const AutomationsView = lazy(() =>
  import("@/pages/AutomationsView").then((module) => ({ default: module.AutomationsView })),
);
const ConnectorsView = lazy(() =>
  import("@/pages/ConnectorsView").then((module) => ({ default: module.ConnectorsView })),
);
const ReportsView = lazy(() => import("@/pages/ReportsView").then((module) => ({ default: module.ReportsView })));
const SettingsView = lazy(() => import("@/pages/SettingsView").then((module) => ({ default: module.SettingsView })));

function RouteFallback({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center p-8" role="status" aria-label={`Loading ${label}`}>
      <div className="h-8 w-48 animate-pulse rounded-md bg-secondary" />
    </div>
  );
}

function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => {
      setHash(window.location.hash);
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash.replace(/^#/, "") || "/chat";
}

export default function App() {
  const route = useHashRoute();
  const lastWorkspaceRoute = useRef("/chat");
  const desktopStartup = useRef(hasDesktopBridge());
  const [desktopSessionReady, setDesktopSessionReady] = useState(!desktopStartup.current);

  useEffect(() => {
    if (!desktopStartup.current) return;
    let mounted = true;
    void initializeDesktopSession().then(() => {
      if (mounted) setDesktopSessionReady(true);
    });
    return () => {
      mounted = false;
    };
  }, []);

  // Do not mount authenticated pages (and their API effects) until the desktop
  // preload has handed off its one-time bootstrap session.
  if (!desktopSessionReady) return null;

  const user = getUser();
  const loggedIn = Boolean(user && user.id);

  if (!loggedIn) {
    return <AuthPage />;
  }

  // route: /chat[:/id] | /sources | /connectors | /reports | /settings | /login
  if (route.startsWith("/login")) {
    window.location.hash = "/chat";
    return null;
  }

  const settingsOpen = route.startsWith("/settings");
  if (!settingsOpen) lastWorkspaceRoute.current = route;
  const workspaceRoute = settingsOpen ? lastWorkspaceRoute.current : route;

  let page: React.ReactNode;
  const [routePath] = workspaceRoute.split("?");
  const chatSegment = routePath.split("/")[2];
  if (workspaceRoute.startsWith("/chat")) {
    page = (
      <ChatView
        chatId={chatSegment && chatSegment !== "new" ? chatSegment : undefined}
        newChatRequest={chatSegment === "new" ? workspaceRoute : undefined}
      />
    );
  } else if (workspaceRoute.startsWith("/sources")) page = <SourcesView />;
  else if (workspaceRoute.startsWith("/libraries")) page = <LibrariesView />;
  else if (workspaceRoute.startsWith("/agents")) page = <AgentsView />;
  else if (workspaceRoute.startsWith("/automations")) page = <AutomationsView />;
  else if (workspaceRoute.startsWith("/connectors")) page = <ConnectorsView />;
  else if (workspaceRoute.startsWith("/reports")) page = <ReportsView />;
  else page = <ChatView chatId={undefined} />;

  return (
    <Shell>
      <LazyLoadBoundary label="This workspace view" resetKey={route}>
        <Suspense fallback={<RouteFallback label="workspace" />}>{page}</Suspense>
      </LazyLoadBoundary>
      {settingsOpen && (
        <LazyLoadBoundary label="Settings" resetKey="settings">
          <Suspense fallback={<RouteFallback label="Settings" />}>
            <SettingsView onClose={() => (window.location.hash = lastWorkspaceRoute.current)} />
          </Suspense>
        </LazyLoadBoundary>
      )}
    </Shell>
  );
}
