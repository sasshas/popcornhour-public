import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { BellRing, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { getNotifyState, runReleaseCheckNow, sendTestNotification } from "@/lib/notify.functions";
import { SettingsSubpage } from "@/components/settings/SettingsSubpage";

export const Route = createFileRoute("/settings/notifications")({ component: NotificationsPage });

function when(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
  const time = d.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${date}, ${time}`;
}

const BUTTON =
  "inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium disabled:opacity-50";

function NotificationsPage() {
  const qc = useQueryClient();
  const fetchState = useServerFn(getNotifyState);
  const fetchTest = useServerFn(sendTestNotification);
  const fetchRun = useServerFn(runReleaseCheckNow);
  const { data: state } = useQuery({ queryKey: ["notify-state"], queryFn: () => fetchState() });

  const test = useMutation({
    mutationFn: () => fetchTest(),
    onSuccess: () => toast.success("Test sent to Home Assistant"),
    onError: (e: Error) => toast.error(`Test failed: ${e.message}`),
  });
  const run = useMutation({
    mutationFn: () => fetchRun(),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["notify-state"] });
      if (r.problem && r.checked === 0) toast.error(r.problem);
      else toast.success(r.sent ? `Sent ${r.sent} notification${r.sent === 1 ? "" : "s"}` : "Nothing new to tell you");
    },
    onError: (e: Error) => toast.error(`Check failed: ${e.message}`),
  });

  const last = state?.lastRun;

  return (
    <SettingsSubpage title="Notifications" hint="A message on your phone when a movie on your watchlist comes out.">
      <div className="space-y-5 text-sm">
        <div className="space-y-2">
          <p>
            Every day at {state?.runHour ?? 9}am, Popcornhour checks the movies on your watchlist that you haven't watched yet.
            Through Home Assistant, it tells you when one:
          </p>
          <ul className="list-disc pl-5 space-y-1 text-muted-foreground">
            <li>is on a streaming service in the US for the first time</li>
            <li>is out to rent or buy in the US (its US digital date)</li>
            <li>is in US cinemas (its US cinema date)</li>
          </ul>
          <p className="text-muted-foreground">
            Each is sent once. A movie you've just put on the watchlist starts from what's true now, so you won't get
            messages about things that already happened.
          </p>
        </div>

        {state && !state.enabled && (
          <p className="rounded-xl bg-muted/60 px-3 py-2">
            Off. Set <code>HA_WEBHOOK_URL</code> in <code>.env</code> to your Home Assistant webhook address and restart
            Popcornhour to switch it on.
          </p>
        )}

        {state?.enabled && (
          <>
            <p className="text-muted-foreground">
              Watching {state.watchlistMovies} movie{state.watchlistMovies === 1 ? "" : "s"}.{" "}
              {last
                ? `Last checked ${when(last.at)}: ${last.sent} sent${last.failed ? `, ${last.failed} could not be checked` : ""}.`
                : "Not checked yet."}
            </p>
            {last?.problem && last.failed > 0 && (
              <p className="rounded-xl bg-destructive/15 px-3 py-2">{last.problem}</p>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => test.mutate()}
                disabled={test.isPending}
                className={`${BUTTON} bg-primary text-primary-foreground hover:opacity-90`}
              >
                {test.isPending ? <Loader2 className="size-4 animate-spin" /> : <BellRing className="size-4" />}
                Send test notification
              </button>
              <button
                onClick={() => run.mutate()}
                disabled={run.isPending}
                className={`${BUTTON} border border-border hover:bg-white/[0.04]`}
              >
                {run.isPending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                {run.isPending ? "Checking…" : "Check now"}
              </button>
            </div>
          </>
        )}
      </div>
    </SettingsSubpage>
  );
}
