import { useEffect, useMemo, useState } from "react";
import { Shell } from "@/components/Shell";
import { AuthPage } from "@/pages/AuthPage";
import { ChatView } from "@/pages/ChatView";
import { SourcesView } from "@/pages/SourcesView";
import { ConnectorsView } from "@/pages/ConnectorsView";
import { ReportsView } from "@/pages/ReportsView";
import { getUser } from "@/lib/api";

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
  const user = getUser();
  const loggedIn = useMemo(() => Boolean(user && user.id), [user]);

  if (!loggedIn) {
    return <AuthPage />;
  }

  // route: /chat[:/id] | /sources | /connectors | /reports | /login
  if (route.startsWith("/login")) {
    window.location.hash = "/chat";
    return null;
  }

  let page: React.ReactNode;
  if (route.startsWith("/chat")) page = <ChatView chatId={route.split("/")[2] || undefined} />;
  else if (route.startsWith("/sources")) page = <SourcesView />;
  else if (route.startsWith("/connectors")) page = <ConnectorsView />;
  else if (route.startsWith("/reports")) page = <ReportsView />;
  else page = <ChatView chatId={undefined} />;

  return <Shell>{page}</Shell>;
}
