import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { login } from "@/lib/auth.functions";
import { useAuth } from "@/hooks/use-auth";

export const Route = createFileRoute("/login")({
  head: () => ({ meta: [{ title: "Sign in — Popcornhour" }] }),
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user, loading } = useAuth();
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loading && user) navigate({ to: "/library" });
  }, [user, loading, navigate]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await login({ data: { password } });
      // Session cookie is set; refetch everything that depends on being signed in.
      await qc.invalidateQueries();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-[calc(100vh-3.5rem)] md:min-h-screen grid place-items-center px-4 py-10">
      <div className="w-full max-w-md space-y-6">
        <Link to="/" className="flex items-center gap-2 justify-center">
          <img src="/favicon.svg" alt="" className="size-9" />
          <span className="font-semibold tracking-tight text-xl">Popcornhour</span>
        </Link>
        <div className="bg-surface border border-border rounded-2xl p-6 space-y-5">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Welcome back</h1>
            <p className="text-sm text-muted-foreground mt-1">Enter your password to open your library.</p>
          </div>
          <form onSubmit={handleSubmit} className="space-y-3">
            <input type="password" required autoFocus autoComplete="current-password" value={password}
              onChange={(e) => setPassword(e.target.value)} placeholder="Password"
              className="w-full h-11 px-3 rounded-lg bg-background border border-border focus:border-primary outline-none focus:ring-2 focus:ring-primary/30" />
            {err && <p className="text-sm text-destructive">{err}</p>}
            <button disabled={busy} type="submit" className="w-full h-11 rounded-lg bg-primary text-primary-foreground font-semibold hover:opacity-90 disabled:opacity-60">
              {busy ? "Please wait…" : "Sign in"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
