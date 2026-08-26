import { useEffect, useRef, useState } from "react";
import { Shell } from "@/components/Shell";
import { AuthPage } from "@/pages/AuthPage";
import { ChatView } from "@/pages/ChatView";
import { SourcesView } from "@/pages/SourcesView";
import { ConnectorsView } from "@/pages/ConnectorsView";
import { ReportsView } from "@/pages/ReportsView";
import { SettingsView } from "@/pages/SettingsView";
import { getUser } from "@/lib/api";
import { hasDesktopBridge, initializeDesktopSession } from "@/lib/desktopBootstrap";

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
  else if (workspaceRoute.startsWith("/connectors")) page = <ConnectorsView />;
  else if (workspaceRoute.startsWith("/reports")) page = <ReportsView />;
  else page = <ChatView chatId={undefined} />;

  return (
    <Shell>
      {page}
      {settingsOpen && <SettingsView onClose={() => (window.location.hash = lastWorkspaceRoute.current)} />}
    </Shell>
  );
}
