import { useState } from "react";
import { Sparkles, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { authApi, setSession, getUser } from "@/lib/api";

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
      const res =
        mode === "login"
          ? await authApi.login(email, password)
          : await authApi.register(email, password);
      setSession(res.token, res.user);
      window.location.hash = "/chat";
      window.location.reload();
    } catch (err: any) {
      setError(err.message || "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4">
      {/* ambient aurora blobs */}
      <div className="pointer-events-none absolute -left-32 -top-32 h-96 w-96 rounded-full bg-aurora-teal/10 blur-3xl animate-aurora-pulse" />
      <div className="pointer-events-none absolute -right-24 top-1/4 h-96 w-96 rounded-full bg-aurora-violet/10 blur-3xl animate-aurora-pulse [animation-delay:2s]" />
      <div className="pointer-events-none absolute bottom-0 left-1/3 h-80 w-80 rounded-full bg-aurora-blue/10 blur-3xl animate-aurora-pulse [animation-delay:4s]" />
      <div className="aurora-top fixed inset-x-0 top-0 z-50 h-[2px] animate-shimmer" />

      <div className="relative z-10 grid w-full max-w-4xl items-center gap-12 lg:grid-cols-2">
        {/* left: pitch */}
        <div className="hidden lg:block">
          <div className="mb-6 flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-aurora-teal to-aurora-violet shadow-xl shadow-aurora-violet/25">
              <Sparkles className="h-6 w-6 text-slate-950" />
            </div>
            <div>
              <div className="text-2xl font-bold tracking-tight">Borealis</div>
              <div className="text-sm text-muted-foreground">Cohere North · open-source MVP</div>
            </div>
          </div>
          <h1 className="text-4xl font-extrabold leading-[1.15] tracking-tight">
            Chat with your{" "}
            <span className="bg-gradient-to-r from-aurora-teal via-aurora-blue to-aurora-violet bg-clip-text text-transparent">
              connected data
            </span>
            .
            <br />
            Answer with charts &amp; reports.
          </h1>
          <p className="mt-4 max-w-md text-[15px] leading-relaxed text-muted-foreground">
            Upload spreadsheets and documents, connect external URLs, then ask questions.
            The agent writes SQL, renders charts, and assembles polished HTML + PDF reports —
            fully local on an OpenAI-compatible stack.
          </p>
          <ul className="mt-8 space-y-3">
            {[
              "Ground truth answers from your files",
              "Charts rendered for chat and PDF",
              "One-click HTML & PDF reports",
            ].map((t) => (
              <li key={t} className="flex items-center gap-2.5 text-sm text-muted-foreground">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-aurora-teal/15 text-aurora-teal text-xs">✓</span>
                {t}
              </li>
            ))}
          </ul>
        </div>

        {/* right: form */}
        <Card className="w-full border border-white/5 bg-card/70 shadow-2xl backdrop-blur-xl">
          <CardContent className="p-8">
            <div className="mb-7 flex items-center gap-3 lg:hidden">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-aurora-teal to-aurora-violet">
                <Sparkles className="h-5 w-5 text-slate-950" />
              </div>
              <div className="text-xl font-bold">Borealis</div>
            </div>
            <h2 className="text-2xl font-bold tracking-tight">
              {mode === "login" ? "Welcome back" : "Create your account"}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {mode === "login" ? "Sign in to start a conversation." : "Self-hosted — your data stays local."}
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
                  className="h-11 bg-background/60"
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
                  className="h-11 bg-background/60"
                />
              </div>
              {error && (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive-foreground">
                  {error}
                </div>
              )}
              <Button type="submit" disabled={busy} className="h-11 w-full" variant="aurora">
                {busy && <Loader2 className="animate-spin" />}
                {mode === "login" ? "Sign in" : "Create account"}
              </Button>
            </form>

            <p className="mt-5 text-center text-sm text-muted-foreground">
              {mode === "login" ? "New here?" : "Already have an account?"}{" "}
              <button
                className="font-medium text-aurora-teal hover:underline"
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
              className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-muted-foreground backdrop-blur transition-colors hover:border-aurora-teal/40 hover:text-foreground"
            >
              {p.title}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
