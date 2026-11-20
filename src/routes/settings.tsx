import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";

/**
 * Settings is a menu (settings.index.tsx) with one page per section: /settings/account, /settings/appearance,
 * /settings/sync, /settings/backup and /settings/maintenance. This frame only does what every one of them needs.
 */
export const Route = createFileRoute("/settings")({ component: SettingsLayout });

function SettingsLayout() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();

  // Surface the Trakt sign-in result from the query string (the callback sends you to /settings/sync).
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const t = sp.get("trakt");
    if (!t) return;
    if (t === "connected") {
      toast.success("Trakt connected");
      qc.invalidateQueries({ queryKey: ["sync-state"] });
    } else if (t === "error") {
      toast.error(`Trakt connection failed: ${sp.get("reason") ?? "unknown"}`);
    }
    window.history.replaceState(window.history.state, "", window.location.pathname);
  }, [qc]);

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/login" });
  }, [user, loading, navigate]);

  return <Outlet />;
}
