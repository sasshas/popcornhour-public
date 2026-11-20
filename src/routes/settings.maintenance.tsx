import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Image as ImageIcon } from "lucide-react";
import { clearPosterRefreshJob, getPosterRefreshJob, startPosterRefresh } from "@/lib/posters.functions";
import { SettingsSubpage } from "@/components/settings/SettingsSubpage";

export const Route = createFileRoute("/settings/maintenance")({ component: MaintenancePage });

function MaintenancePage() {
  const qc = useQueryClient();
  const fetchJob = useServerFn(getPosterRefreshJob);
  const fetchStart = useServerFn(startPosterRefresh);
  const fetchClear = useServerFn(clearPosterRefreshJob);
  const [problem, setProblem] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const { data: job, refetch } = useQuery({
    queryKey: ["poster-refresh-job"],
    queryFn: () => fetchJob(),
    gcTime: 0,
    staleTime: 0,
    // Checked every second while it runs, and at once when the phone wakes up and the page shows again.
    refetchInterval: (q) => (q.state.data?.state === "running" ? 1000 : false),
    refetchOnWindowFocus: true,
  });

  const running = job?.state === "running";
  const finished = job && job.state !== "running" ? job.finishedAt : null;

  // When a refresh finishes, the posters shown elsewhere are read again.
  useEffect(() => {
    if (!finished) return;
    for (const key of ["library", "lists", "list"]) qc.invalidateQueries({ queryKey: [key] });
  }, [finished, qc]);

  async function start() {
    setProblem(null);
    setStarting(true);
    try {
      await fetchStart();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "Could not start");
    }
    await refetch();
    setStarting(false);
  }

  async function dismiss() {
    await fetchClear().catch(() => {});
    await refetch();
  }

  const pct = job && job.total > 0 ? Math.round((job.current / job.total) * 100) : 0;

  return (
    <SettingsSubpage title="Library maintenance" hint="Fix missing artwork on imported items.">
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <p className="text-sm text-muted-foreground">Looks up posters again for anything that is missing one.</p>
          <button
            onClick={start}
            disabled={running || starting}
            className="inline-flex items-center gap-2 rounded-full bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:opacity-90 disabled:opacity-50"
          >
            {running || starting ? <Loader2 className="size-4 animate-spin" /> : <ImageIcon className="size-4" />}
            {running ? "Refreshing…" : "Refresh posters"}
          </button>
        </div>

        {running && job && (
          <div className="space-y-2">
            <div
              className="h-1.5 overflow-hidden rounded-full bg-border"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={job.total}
              aria-valuenow={job.current}
            >
              <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
            </div>
            <p className="text-sm">
              Looked up {job.current} of {job.total} · {job.updated} found
            </p>
            <p className="text-xs text-muted-foreground">
              You can lock your phone or leave this page. It keeps going on the server, and coming back here shows where it is.
            </p>
          </div>
        )}

        {job && job.state === "done" && (
          <div className="flex items-center justify-between gap-3 rounded-xl bg-muted/60 px-3 py-2 text-sm">
            <p>
              {job.total === 0
                ? "Nothing is missing a poster."
                : `Refreshed ${job.updated} of ${job.total} posters.${job.missed ? ` TMDB had none for ${job.missed}.` : ""}`}
            </p>
            <button onClick={dismiss} className="shrink-0 text-muted-foreground hover:text-foreground">
              Done
            </button>
          </div>
        )}

        {(problem || job?.state === "error") && (
          <div className="flex items-center justify-between gap-3 rounded-xl bg-destructive/15 px-3 py-2 text-sm">
            <p>
              {problem ?? job?.problem ?? "Refresh posters failed"}
              {job?.state === "error" && job.updated > 0 ? ` (${job.updated} posters were saved before it stopped.)` : ""}
            </p>
            {job?.state === "error" && (
              <button onClick={dismiss} className="shrink-0 text-muted-foreground hover:text-foreground">
                Done
              </button>
            )}
          </div>
        )}
      </div>
    </SettingsSubpage>
  );
}
