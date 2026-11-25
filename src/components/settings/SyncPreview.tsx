import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  discardSyncChanges, getSyncPreview, pushSync, type PreviewItem, type SyncService,
} from "@/lib/sync.functions";
import { getMovie, getTV } from "@/lib/tmdb.functions";
import { formatDateTimeAU } from "@/lib/utils";
import { isUnknownWatchedAt } from "@/lib/watched-date";

type StreamEvent = {
  type: string; phase?: string; current?: number; total?: number; summary?: Record<string, number>; message?: string;
};

const NAME: Record<SyncService, string> = { trakt: "Trakt", wetrakr: "WeTrakr" };

/** What one waiting change will do on the service, in plain words. */
function describe(i: PreviewItem): string {
  const ep = i.season != null && i.episode != null ? `S${i.season} E${i.episode}` : null;
  const noDate = isUnknownWatchedAt(i.watchedAt);
  if (i.kind === "watch") return `${ep ? `${ep} watched` : "Watched"}${noDate ? ", date unknown" : ` ${formatDateTimeAU(i.watchedAt)}`}`;
  if (i.kind === "unwatch") return ep ? `${ep}: remove from watched` : "Remove from watched";
  if (i.kind === "unplay") return `${ep ? `${ep}: remove` : "Remove"} ${noDate ? "the play with no date" : `the play on ${formatDateTimeAU(i.watchedAt)}`}`;
  if (i.kind === "watchlist") return i.value === 1 ? "Add to watchlist" : "Remove from watchlist";
  if (i.kind === "favorite") return i.value === 1 ? "Add to favourites" : "Remove from favourites";
  if (i.kind === "status") {
    return i.status === "dropped" ? "Mark as dropped" : i.status === "on_hold" ? "Mark as paused" : "Back to watching";
  }
  if (i.kind === "list_item") return `${i.value === 1 ? "Add to" : "Remove from"} list “${i.listName ?? ""}”`;
  if (i.kind === "list") {
    if (i.value === 0) return "Delete this list";
    if (!i.prevName) return "Create this list";
    return i.prevName !== i.listName ? `Rename list (was “${i.prevName}”)` : "Update this list's description";
  }
  const rating = i.value === null ? "remove rating" : `rating ${i.value}/10`;
  return ep ? `${ep}: ${rating}` : rating[0].toUpperCase() + rating.slice(1);
}

/**
 * The Sync preview: every change made in this app that is waiting to be sent, listed per
 * connected service and checked against that service first. Nothing is sent until "Send" is
 * pressed, and only the ticked rows go.
 */
export function SyncPreview({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const fetchPreview = useServerFn(getSyncPreview);
  const fetchPush = useServerFn(pushSync);
  const fetchDiscard = useServerFn(discardSyncChanges);
  const fetchTV = useServerFn(getTV);
  const fetchMovie = useServerFn(getMovie);

  const { data, isFetching, refetch } = useQuery({
    queryKey: ["sync-preview"],
    queryFn: () => fetchPreview(),
    gcTime: 0,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });

  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState<{ phase: string; current: number; total: number } | null>(null);
  const [result, setResult] = useState<Record<string, number> | null>(null);
  const [problems, setProblems] = useState<string[]>([]);

  const max = data?.maxPerSync ?? 50;
  const rawGroups = data?.groups ?? [];
  const rawItems = rawGroups.flatMap((g) => (g.ok ? g.items : []));

  // An episode of a show that is not in the library was saved without the show's name
  // ("Show 2207"): look the name up so the list can be read.
  const nameless = [
    ...new Map(
      rawItems.filter((i) => i.kind !== "list" && /^(Show|Movie) \d+$/.test(i.title)).map((i) => [`${i.mediaType}:${i.tmdbId}`, i]),
    ).values(),
  ];
  const lookups = useQueries({
    queries: nameless.map((i) => ({
      queryKey: ["sync-title", i.mediaType, i.tmdbId],
      queryFn: async () =>
        i.mediaType === "tv"
          ? (await fetchTV({ data: { id: i.tmdbId } })).name
          : (await fetchMovie({ data: { id: i.tmdbId } })).title,
      staleTime: Infinity,
    })),
  });
  const names = new Map(nameless.map((i, n) => [`${i.mediaType}:${i.tmdbId}`, lookups[n]?.data]));
  const named = (i: PreviewItem) => ({ ...i, title: names.get(`${i.mediaType}:${i.tmdbId}`) || i.title });

  const groups = rawGroups.map((g) => (g.ok ? { ...g, items: g.items.map(named) } : g));
  const sendable = groups.flatMap((g) => (g.ok ? g.items.filter((i) => !i.skip) : []));
  const skippedCount = groups.reduce((n, g) => n + (g.ok ? g.items.filter((i) => i.skip).length : 0), 0);
  const total = groups.reduce((n, g) => n + (g.ok ? g.items.length : 0), 0);
  const failed = groups.filter((g) => !g.ok);

  // Start with every addition ticked. Removals start ticked only when "Confirm deletions" is off.
  // At most `max` per service.
  useEffect(() => {
    if (!data) return;
    const start = data.groups.flatMap((g) =>
      g.ok
        ? g.items.filter((i) => !i.skip && (!i.removal || !data.confirmDeletions)).slice(0, data.maxPerSync).map((i) => i.id)
        : [],
    );
    setTicked(new Set(start));
  }, [data]);

  const toggle = (id: string, inGroup: PreviewItem[]) =>
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (inGroup.filter((i) => next.has(i.id)).length < max) next.add(id);
      else toast.message(`At most ${max} changes are sent to one service at a time.`);
      return next;
    });

  const refreshEverything = () => {
    qc.invalidateQueries({ queryKey: ["sync-state"] });
    qc.invalidateQueries({ queryKey: ["backups"] });
  };

  async function send() {
    setProblems([]);
    setSending({ phase: "", current: 0, total: 0 });
    const errors: string[] = [];
    try {
      for await (const evt of (await fetchPush({ data: { ids: [...ticked] } })) as AsyncIterable<StreamEvent>) {
        if (evt.type === "phase" || evt.type === "progress") {
          setSending({ phase: evt.phase ?? "", current: evt.current ?? 0, total: evt.total ?? 0 });
        } else if (evt.type === "done") setResult(evt.summary ?? {});
        else if (evt.type === "error") errors.push(evt.message ?? "Sync failed");
      }
    } catch (e) {
      errors.push(e instanceof Error ? e.message : "Sync failed");
    }
    setProblems(errors);
    setSending(null);
    refreshEverything();
  }

  async function discard(ids: string[]) {
    try {
      await fetchDiscard({ data: { ids } });
      refreshEverything();
      await refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not forget those changes");
    }
  }

  const BTN = "rounded-full px-4 py-2.5 text-sm font-medium disabled:opacity-50";
  const Problems = () =>
    problems.length > 0 ? (
      <div className="space-y-1 rounded-xl bg-destructive/15 px-3 py-2 text-sm">
        {problems.map((p) => <p key={p}>{p}</p>)}
      </div>
    ) : null;

  if (result) {
    const lines = (Object.keys(NAME) as SyncService[])
      .map((s) => {
        const n = (k: string) => result[`${s}.${k}`] ?? 0;
        const parts = [
          n("sent") ? `${n("sent")} sent` : null,
          n("removed") ? `${n("removed")} removed` : null,
          n("alreadyThere") ? `${n("alreadyThere")} already there` : null,
          n("notFound") ? `${n("notFound")} not found (dropped)` : null,
          n("failed") ? `${n("failed")} refused (still waiting)` : null,
        ].filter(Boolean);
        return parts.length ? `${NAME[s]}: ${parts.join(", ")}` : null;
      })
      .filter(Boolean);
    return (
      <div className="space-y-4">
        <Problems />
        <div className="flex items-start gap-2 text-sm">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" />
          <div>{lines.length ? lines.map((l) => <p key={l}>{l}</p>) : <p>Nothing was sent.</p>}</div>
        </div>
        <button type="button" onClick={onClose} className={`${BTN} w-full bg-white/[0.07]`}>Done</button>
      </div>
    );
  }

  if (sending) {
    const pct = sending.total > 0 ? Math.round((sending.current / sending.total) * 100) : 0;
    return (
      <div className="space-y-2">
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {sending.total > 0
            ? `${sending.phase}: sending ${sending.current} of ${sending.total}…`
            : sending.phase
              ? `Checking ${sending.phase}…`
              : "Saving a backup…"}
        </p>
        <div className="h-1.5 overflow-hidden rounded-full bg-border">
          <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
        </div>
      </div>
    );
  }

  if (isFetching || !data) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Checking what your services already have…
      </p>
    );
  }
  if (total === 0 && failed.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Nothing to send. Changes you make in this app from now on (watched, watchlist, ratings, favourites, lists, Dropped and Paused) are sent.
      </p>
    );
  }

  const unticked = sendable.filter((i) => !ticked.has(i.id));

  return (
    <div className="space-y-4">
      <Problems />
      <div className="-mr-2 max-h-[52vh] space-y-5 overflow-y-auto pr-2">
        {groups.map((g) => {
          if (!g.ok) {
            return (
              <div key={g.service}>
                <h4 className="text-sm font-semibold">{NAME[g.service]}</h4>
                <p className="text-xs text-muted-foreground">Could not check {NAME[g.service]}: {g.message}</p>
              </div>
            );
          }
          if (g.items.length === 0) return null;
          const ok = g.items.filter((i) => !i.skip);
          const adds = ok.filter((i) => !i.removal);
          const removals = ok.filter((i) => i.removal);
          const skipped = g.items.filter((i) => i.skip);
          const line = (i: PreviewItem) => (
            <Line key={i.id} item={i} checked={ticked.has(i.id)} onToggle={() => toggle(i.id, ok)} />
          );
          return (
            <div key={g.service} className="space-y-3">
              {groups.length > 1 && <h4 className="text-sm font-semibold">{NAME[g.service]}</h4>}
              {adds.length > 0 && <Group title={`To send (${adds.length})`}>{adds.map(line)}</Group>}
              {removals.length > 0 && (
                <Group title={`Removals (${removals.length})`} note={`Tick the ones you really want removed on ${NAME[g.service]}.`}>
                  {removals.map(line)}
                </Group>
              )}
              {skipped.length > 0 && (
                <Group title={`Won't be sent (${skipped.length})`}>
                  {skipped.map((i) => (
                    <li key={i.id} className="rounded-2xl bg-white/[0.04] px-3.5 py-2.5 opacity-70">
                      <div className="truncate text-sm font-medium">{i.title}</div>
                      <div className="text-xs text-muted-foreground">{describe(i)} · {i.skip}</div>
                    </li>
                  ))}
                </Group>
              )}
              {ok.length > max && (
                <p className="text-xs text-muted-foreground">At most {max} go to {NAME[g.service]} at a time. Sync again for the rest.</p>
              )}
            </div>
          );
        })}
      </div>
      <div className="space-y-2">
        <button
          type="button"
          disabled={ticked.size === 0 && skippedCount === 0}
          onClick={send}
          className={`${BTN} w-full bg-primary text-primary-foreground`}
        >
          {ticked.size > 0
            ? `Send ${ticked.size} change${ticked.size === 1 ? "" : "s"}`
            : skippedCount > 0
              ? "Clear the ones that won't be sent"
              : "Nothing ticked"}
        </button>
        {unticked.length > 0 && (
          <button type="button" onClick={() => discard(unticked.map((i) => i.id))} className={`${BTN} w-full bg-white/[0.07]`}>
            Forget the {unticked.length} unticked
          </button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">A backup of your library is saved first. Unticked changes keep waiting.</p>
    </div>
  );
}

function Group({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div>
      <h5 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h5>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
      <ul className="mt-1.5 space-y-1.5">{children}</ul>
    </div>
  );
}

function Line({ item, checked, onToggle }: { item: PreviewItem; checked: boolean; onToggle: () => void }) {
  return (
    <li>
      <label className="flex cursor-pointer items-center gap-3 rounded-2xl bg-white/[0.07] px-3.5 py-2.5">
        <input type="checkbox" checked={checked} onChange={onToggle} className="size-4 shrink-0 accent-[var(--primary)]" />
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{item.title}</span>
          <span className={`block text-xs ${item.removal ? "text-destructive" : "text-muted-foreground"}`}>{describe(item)}</span>
        </span>
      </label>
    </li>
  );
}
