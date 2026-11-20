import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { LogOut } from "lucide-react";
import { toast } from "sonner";
import { useAuth, signOut } from "@/hooks/use-auth";
import { getMyProfile, updateMyProfile } from "@/lib/library.functions";
import { SettingsSubpage } from "@/components/settings/SettingsSubpage";

export const Route = createFileRoute("/settings/account")({ component: AccountPage });

/** Your display name and Sign out (this used to be the separate Profile page). */
function AccountPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const fetchProfile = useServerFn(getMyProfile);
  const fetchUpdate = useServerFn(updateMyProfile);
  const [name, setName] = useState("");

  const { data: profile } = useQuery({
    queryKey: ["profile", user?.id],
    queryFn: () => fetchProfile(),
    enabled: !!user,
  });
  useEffect(() => {
    if (profile?.display_name) setName(profile.display_name);
  }, [profile?.display_name]);

  const save = useMutation({
    mutationFn: () => fetchUpdate({ data: { displayName: name.trim() || null } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["profile"] });
      toast.success("Saved");
    },
  });

  return (
    <SettingsSubpage title="Account" hint="Your name in the app, and signing out.">
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <label htmlFor="display-name" className="text-xs uppercase tracking-wide text-muted-foreground">
          Display name
        </label>
        <div className="flex gap-2">
          <input
            id="display-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            className="h-11 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 outline-none focus:border-primary focus:ring-2 focus:ring-primary/30"
          />
          <button
            type="submit"
            disabled={save.isPending}
            className="rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-60"
          >
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
      <button
        type="button"
        onClick={() => signOut()}
        className="mt-5 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-destructive"
      >
        <LogOut className="size-4" /> Sign out
      </button>
    </SettingsSubpage>
  );
}
