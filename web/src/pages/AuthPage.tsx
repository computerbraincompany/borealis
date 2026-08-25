import { useState } from "react";
import { Sparkles, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { ThemeMenu } from "@/components/ThemeMenu";
import { authApi, formatApiError, setSession, getUser } from "@/lib/api";

const SUGGESTED_PROMPTS = [
  { title: "Personal finance analysis", prompt: "Analyze my spending and produce a financial report with charts" },
  { title: "Ask about a document", prompt: "Summarize the uploaded documents and give key takeaways" },
  { title: "Build a report", prompt: "Create a professional report with charts from my data" },
];

export function AuthPage() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const user = getUser();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = mode === "login" ? await authApi.login(email, password) : await authApi.register(email, password);
      setSession(res.token, res.user);
      window.location.hash = "/chat";
      window.location.reload();
    } catch (error: unknown) {
      setError(formatApiError(error, "Something went wrong"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4">
      <div className="pointer-events-none absolute inset-y-0 left-0 hidden w-[44%] border-r bg-sidebar lg:block" />
      <div className="absolute right-4 top-4 z-20 rounded-lg border bg-card shadow-sm">
        <ThemeMenu />
      </div>

      <div className="relative z-10 grid w-full max-w-5xl items-center gap-14 lg:grid-cols-[1.05fr_0.95fr]">
        {/* left: pitch */}
        <div className="hidden lg:block">
          <div className="mb-6 flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary shadow-sm">
              <Sparkles className="h-6 w-6 text-primary-foreground" />
            </div>
            <div>
              <div className="text-2xl font-bold tracking-tight">Borealis</div>
              <div className="text-sm text-muted-foreground">AI data workspace</div>
            </div>
          </div>
          <h1 className="text-4xl font-extrabold leading-[1.15] tracking-tight">
            Chat with your <span className="text-primary">connected data</span>
            .
            <br />
            Answer with charts &amp; reports.
          </h1>
          <p className="mt-4 max-w-md text-[15px] leading-relaxed text-muted-foreground">
            Upload spreadsheets and documents, connect shared datasets, then ask questions. Borealis queries your data,
            builds charts, and assembles HTML + PDF reports.
          </p>
          <ul className="mt-8 space-y-3">
            {[
              "Ground truth answers from your files",
              "Charts rendered for chat and PDF",
              "One-click HTML & PDF reports",
            ].map((t) => (
              <li key={t} className="flex items-center gap-2.5 text-sm text-muted-foreground">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-xs text-primary">
                  ✓
                </span>
                {t}
              </li>
            ))}
          </ul>
        </div>

        {/* right: form */}
        <Card className="w-full border-l-2 border-l-primary bg-card shadow-sm">
          <CardContent className="p-8">
            <div className="mb-7 flex items-center gap-3 lg:hidden">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary">
                <Sparkles className="h-5 w-5 text-primary-foreground" />
              </div>
              <div>
                <div className="text-xl font-bold">Borealis</div>
                <div className="text-xs text-muted-foreground">AI data workspace</div>
              </div>
            </div>
            <h2 className="text-2xl font-bold tracking-tight">
              {mode === "login" ? "Welcome back" : "Create your account"}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {mode === "login"
                ? "Sign in to start a conversation."
                : "Create a workspace account to start analyzing data."}
            </p>

            <form onSubmit={submit} className="mt-7 space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  required
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="h-11 bg-background"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  required
                  autoComplete={mode === "login" ? "current-password" : "new-password"}
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="h-11 bg-background"
                />
              </div>
              {error && (
                <div
                  className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                  role="alert"
                >
                  {error}
                </div>
              )}
              <Button type="submit" disabled={busy} className="h-11 w-full">
                {busy && <Loader2 className="animate-spin" />}
                {mode === "login" ? "Sign in" : "Create account"}
              </Button>
            </form>

            <p className="mt-5 text-center text-sm text-muted-foreground">
              {mode === "login" ? "New here?" : "Already have an account?"}{" "}
              <button
                className="font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => {
                  setMode(mode === "login" ? "register" : "login");
                  setError(null);
                }}
              >
                {mode === "login" ? "Create an account" : "Sign in"}
              </button>
            </p>
          </CardContent>
        </Card>
      </div>

      {/* strip of quick prompts for signed-in demos */}
      {user && (
        <div className="fixed bottom-5 left-1/2 flex -translate-x-1/2 gap-2">
          {SUGGESTED_PROMPTS.map((p) => (
            <button
              key={p.title}
              onClick={() => {
                window.location.hash = `/chat?q=${encodeURIComponent(p.prompt)}`;
              }}
              className="rounded-md border bg-card px-3 py-1.5 text-xs text-muted-foreground shadow-sm transition-colors hover:border-primary/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {p.title}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
