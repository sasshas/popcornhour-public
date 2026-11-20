import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine, ArrowUpFromLine, CheckCircle2, ChevronDown, Loader2, RotateCw, Scale, TriangleAlert,
} from "lucide-react";
import {
  clearWetrakrCompareJob, getWetrakrCompareJob, startWetrakrApply, startWetrakrCompare, type MirrorItem, type MirrorJob,
} from "@/lib/sync.functions";
import { getMovie, getTV } from "@/lib/tmdb.functions";
import { formatDateTimeAU } from "@/lib/utils";

type Side = "send" | "bring";

/** The kinds of line, in the order they are listed, with their heading. */
const KINDS: { kind: MirrorItem["kind"]; label: string }[] = [
  { kind: "movie", label: "Watched movies" },
  { kind: "episodes", label: "Watched episodes" },
  { kind: "rewatch", label: "Repeat watches" },
  { kind: "dates", label: "Watch dates" },
  { kind: "show", label: "Shows" },
  { kind: "status", label: "Show status" },
  { kind: "watchlist", label: "Watchlist" },
  { kind: "rating", label: "Ratings" },
  { kind: "eprating", label: "Episode ratings" },
  { kind: "favorite", label: "Favourites" },
  { kind: "list", label: "Lists" },
];

/** "just now", "4 minutes ago", "2 hours ago". */
function ago(iso: string | null): string {
  const mins = iso ? Math.floor((Date.now() - Date.parse(iso)) / 60_000) : 0;
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.floor(mins / 60);
  return `${hours} hour${hours === 1 ? "" : "s"} ago`;
}

/** What WeTrakr made of something an earlier Apply sent. */
function sentText(s: NonNullable<MirrorItem["sentBefore"]>): string {
  const when = `sent ${ago(s.at)}`;
  if (s.outcome === "notFound") return `WeTrakr said it doesn't have this (${when})`;
  if (s.outcome === "refused") return `WeTrakr refused it (${when})`;
  return `WeTrakr accepted it but doesn't list it (${when})`;
}

/** Overall share of reading WeTrakr done, 0-100: whole steps, plus the pages of the current one. */
function readPct(job: MirrorJob): number {
  const r = job.read;
  if (!r) return 0;
  const within = r.pages > 0 ? Math.min(1, r.page / r.pages) : 0;
  return Math.round(((r.step - 1 + within) / r.steps) * 100);
}

function readLine(job: MirrorJob): string {
  const r = job.read;
  if (!r) return "Connecting to WeTrakr…";
  const page = r.pages > 1 ? `, page ${Math.min(r.page + 1, r.pages)} of ${r.pages}` : "";
  return `${r.label}${page} (step ${r.step} of ${r.steps})`;
}

/**
 * Compare with WeTrakr: everything Popcornhour has that WeTrakr does not (to send), everything
 * WeTrakr has that Popcornhour does not (to bring in), and the titles the two disagree on (you pick
 * a side). Nothing changes until "Apply" is pressed; Cancel just closes it.
 *
 * The work happens in a job on the server: this screen starts it and checks on it every second, so
 * locking the phone or closing the screen does not lose it. Opening it again shows the job as it is
 * (still reading, or the finished list).
 */
export function WetrakrCompare({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const fetchJob = useServerFn(getWetrakrCompareJob);
  const fetchStart = useServerFn(startWetrakrCompare);
  const fetchApply = useServerFn(startWetrakrApply);
  const fetchClear = useServerFn(clearWetrakrCompareJob);
  const fetchTV = useServerFn(getTV);
  const fetchMovie = useServerFn(getMovie);

  const { data: job, refetch } = useQuery({
    queryKey: ["wetrakr-compare-job"],
    queryFn: () => fetchJob(),
    gcTime: 0,
    staleTime: 0,
    // Checked every second while it runs, and at once when the phone wakes up and the page shows again.
    refetchInterval: (q) => (q.state.data?.state === "running" ? 1000 : false),
    refetchOnWindowFocus: true,
  });
  const [problem, setProblem] = useState<string | null>(null);

  async function start() {
    setProblem(null);
    try {
      await fetchStart();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "Could not start");
    }
    await refetch();
  }

  // Nothing on the server yet (first visit, or after Done): start comparing straight away.
  const started = useRef(false);
  useEffect(() => {
    if (job !== null || started.current) return;
    started.current = true;
    void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job]);

  const compared = job?.kind === "compare" && job.state === "done" ? job : null;
  const raw = useMemo(() => compared?.items ?? [], [compared?.items]);

  // A show known only by its id ("Show 2207"): look its name up so the list can be read.
  const nameless = raw.filter((i) => i.tmdbId != null && /^(Show|Movie) \d+$/.test(i.title));
  const unique = [...new Map(nameless.map((i) => [`${i.mediaType}:${i.tmdbId}`, i])).values()].slice(0, 60);
  const lookups = useQueries({
    queries: unique.map((i) => ({
      queryKey: ["sync-title", i.mediaType, i.tmdbId],
      queryFn: async () =>
        i.mediaType === "tv" ? (await fetchTV({ data: { id: i.tmdbId! } })).name : (await fetchMovie({ data: { id: i.tmdbId! } })).title,
      staleTime: Infinity,
    })),
  });
  const names = new Map(unique.map((i, n) => [`${i.mediaType}:${i.tmdbId}`, lookups[n]?.data]));
  const items = raw.map((i) => ({ ...i, title: names.get(`${i.mediaType}:${i.tmdbId}`) || i.title }));

  // Every line to send or bring in starts ticked; for a difference you pick a side (none to start with).
  // Set again only when a new comparison finishes, not on every check of the job.
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [sides, setSides] = useState<Map<string, Side>>(new Map());
  useEffect(() => {
    setTicked(new Set(raw.filter((i) => i.direction !== "differ" && !i.sentBefore).map((i) => i.id)));
    setSides(new Map());
  }, [raw]);

  const send = items.filter((i) => i.direction === "send" && !i.sentBefore);
  const again = items.filter((i) => i.direction === "send" && i.sentBefore && i.sentBefore.outcome !== "notFound");
  const unknown = items.filter((i) => i.direction === "send" && i.sentBefore?.outcome === "notFound");
  const [showUnknown, setShowUnknown] = useState(false);
  const bring = items.filter((i) => i.direction === "bring");
  const differ = items.filter((i) => i.direction === "differ");
  const choices = useMemo(
    () => [
      ...items.filter((i) => i.direction !== "differ" && ticked.has(i.id)).map((i) => ({ id: i.id, side: i.direction as Side })),
      ...[...sides].map(([id, side]) => ({ id, side })),
    ],
    [items, ticked, sides],
  );

  async function apply() {
    setProblem(null);
    try {
      await fetchApply({ data: { choices } });
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "Could not start");
    }
    await refetch();
  }

  // When an Apply finishes, everything it may have changed here is read again.
  const applyFinished = job?.kind === "apply" && job.state !== "running" ? job.finishedAt : null;
  useEffect(() => {
    if (!applyFinished) return;
    for (const key of ["library", "library-item", "episode-progress", "plays", "lists", "backups", "sync-state"]) {
      qc.invalidateQueries({ queryKey: [key] });
    }
  }, [applyFinished, qc]);

  async function done() {
    await fetchClear().catch(() => {});
    qc.removeQueries({ queryKey: ["wetrakr-compare-job"] });
    onClose();
  }

  const BTN = "rounded-full px-4 py-2.5 text-sm font-medium disabled:opacity-50";
  const Problems = ({ list }: { list: string[] }) =>
    list.length > 0 ? (
      <div className="space-y-1 rounded-xl bg-destructive/15 px-3 py-2 text-sm">
        {list.map((p) => <p key={p}>{p}</p>)}
      </div>
    ) : null;
  const Bar = ({ pct }: { pct: number }) => (
    <div className="h-1.5 overflow-hidden rounded-full bg-border">
      <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
    </div>
  );
  const KeepsGoing = () => (
    <p className="text-xs text-muted-foreground">
      You can lock your phone or close this. It keeps going on the server, and opening Compare again shows where it is.
    </p>
  );

  if (problem && !job) {
    return (
      <div className="space-y-4">
        <Problems list={[problem]} />
        <button type="button" onClick={start} className={`${BTN} w-full bg-white/[0.07]`}>Try again</button>
      </div>
    );
  }

  if (!job) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Starting…
      </p>
    );
  }

  // ---- Apply: running, then its result
  if (job.kind === "apply") {
    if (job.state === "running") {
      const sending = job.phase === "sending" && job.total > 0;
      return (
        <div className="space-y-3">
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 shrink-0 animate-spin" />
            {sending
              ? `Sending to WeTrakr: ${job.current} of ${job.total}…`
              : job.phase === "bringing in"
                ? "Bringing into Popcornhour…"
                : job.phase === "checking"
                  ? `Checking WeTrakr again: ${readLine(job)}`
                  : "Saving a backup…"}
          </p>
          <Bar pct={sending ? Math.round((job.current / job.total) * 100) : job.phase === "checking" ? readPct(job) : 0} />
          <KeepsGoing />
        </div>
      );
    }
    const s = job.summary ?? {};
    const parts = [
      s.broughtIn ? `${s.broughtIn} brought into Popcornhour` : null,
      s.sent ? `${s.sent} sent to WeTrakr` : null,
      s.notFound ? `${s.notFound} with titles WeTrakr did not know` : null,
      s.refused ? `${s.refused} partly refused by WeTrakr` : null,
    ].filter(Boolean);
    return (
      <div className="space-y-4">
        <Problems list={job.problems ?? []} />
        {(parts.length > 0 || !job.problems?.length) && (
          <div className="flex items-start gap-2 text-sm">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" />
            <p>{parts.length ? `${parts.join(", ")}.` : "Nothing was changed."}</p>
          </div>
        )}
        <p className="text-xs text-muted-foreground">Finished {ago(job.finishedAt)}. Compare again any time to check both sides match.</p>
        <button type="button" onClick={done} className={`${BTN} w-full bg-white/[0.07]`}>Done</button>
      </div>
    );
  }

  // ---- Comparing
  if (job.state === "running") {
    return (
      <div className="space-y-3">
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 shrink-0 animate-spin" /> Reading your WeTrakr account: {readLine(job)}
        </p>
        <Bar pct={readPct(job)} />
        <KeepsGoing />
      </div>
    );
  }
  if (job.state === "error" || !compared) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">Could not compare with WeTrakr.</p>
        <Problems list={job.problems ?? []} />
        <button type="button" onClick={start} className={`${BTN} w-full bg-primary text-primary-foreground`}>Try again</button>
        <button type="button" onClick={onClose} className={`${BTN} w-full bg-white/[0.07]`}>Close</button>
      </div>
    );
  }

  const setMany = (ids: string[], on: boolean) =>
    setTicked((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  const ComparedWhen = () => (
    <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
      <span>Compared {ago(compared.finishedAt)}</span>
      <button type="button" onClick={start} className="inline-flex items-center gap-1.5 font-medium text-primary">
        <RotateCw className="size-3.5" /> Compare again
      </button>
    </div>
  );

  // Things WeTrakr said it does not have are not differences anyone can fix: listed quietly, folded away.
  const NotOnWetrakr = () =>
    unknown.length > 0 ? (
      <div className="space-y-2">
        <button
          type="button"
          onClick={() => setShowUnknown((v) => !v)}
          className="flex w-full items-center justify-between gap-2 text-left text-xs text-muted-foreground"
        >
          <span>
            {unknown.length} thing{unknown.length === 1 ? "" : "s"} WeTrakr doesn't have, so {unknown.length === 1 ? "it" : "they"} can't be sent
          </span>
          <ChevronDown className={`size-4 shrink-0 transition-transform ${showUnknown ? "rotate-180" : ""}`} />
        </button>
        {showUnknown && (
          <>
            <p className="text-xs text-muted-foreground">
              Popcornhour's episodes come from TMDB. WeTrakr said it doesn't have these: usually a two-part episode it counts as
              one, or an episode missing from its catalogue. Nothing to do; tick one only to try again.
            </p>
            <Kinds items={unknown} ticked={ticked} setMany={setMany} />
          </>
        )}
      </div>
    ) : null;

  if (items.length === unknown.length) {
    return (
      <div className="space-y-4">
        <ComparedWhen />
        {(compared.notes ?? []).map((n) => <p key={n} className="text-xs text-muted-foreground">{n}</p>)}
        <div className="flex items-start gap-2 text-sm">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" />
          <p>Popcornhour and WeTrakr match{unknown.length ? ", apart from what WeTrakr doesn't have" : ""}.</p>
        </div>
        <NotOnWetrakr />
        {choices.length > 0 && (
          <button type="button" onClick={apply} className={`${BTN} w-full bg-primary text-primary-foreground`}>
            Try {choices.length} again
          </button>
        )}
        <button type="button" onClick={done} className={`${BTN} w-full bg-white/[0.07]`}>Close</button>
      </div>
    );
  }

  // min-w-0: the sheet lays its content out in a grid, and long one-line dates would otherwise widen it past the screen.
  return (
    <div className="min-w-0 space-y-4">
      <div className="-mr-2 max-h-[58vh] space-y-6 overflow-y-auto pr-2">
        <ComparedWhen />
        {(compared.notes ?? []).map((n) => <p key={n} className="text-xs text-muted-foreground">{n}</p>)}
        {send.length > 0 && (
          <Section icon={<ArrowUpFromLine className="size-4" />} title="Popcornhour has, WeTrakr doesn't" note="Ticked ones are added on WeTrakr.">
            <Kinds items={send} ticked={ticked} setMany={setMany} />
          </Section>
        )}
        {bring.length > 0 && (
          <Section icon={<ArrowDownToLine className="size-4" />} title="WeTrakr has, Popcornhour doesn't" note="Ticked ones are added here.">
            <Kinds items={bring} ticked={ticked} setMany={setMany} />
          </Section>
        )}
        {again.length > 0 && (
          <Section
            icon={<TriangleAlert className="size-4" />}
            title="Sent before, still not on WeTrakr"
            note="An earlier Apply sent these and WeTrakr still doesn't show them. Usually WeTrakr doesn't have that title or episode, or numbers it differently. They're left unticked; tick one to try again."
          >
            <Kinds items={again} ticked={ticked} setMany={setMany} />
          </Section>
        )}
        <NotOnWetrakr />
        {differ.length > 0 && (
          <Section icon={<Scale className="size-4" />} title="Different on each" note="Pick which one is right. Left alone, both stay as they are. For watch dates, the side you pick replaces the other side's dates for that title.">
            <ul className="space-y-1.5">
              {differ.map((i) => (
                <DifferLine
                  key={i.id}
                  item={i}
                  side={sides.get(i.id) ?? null}
                  onPick={(s) =>
                    setSides((prev) => {
                      const next = new Map(prev);
                      if (s) next.set(i.id, s);
                      else next.delete(i.id);
                      return next;
                    })
                  }
                />
              ))}
            </ul>
          </Section>
        )}
      </div>
      <div className="space-y-2">
        <button type="button" disabled={choices.length === 0} onClick={apply} className={`${BTN} w-full bg-primary text-primary-foreground`}>
          {choices.length ? `Apply ${choices.length} change${choices.length === 1 ? "" : "s"}` : "Nothing ticked"}
        </button>
        <button type="button" onClick={onClose} className={`${BTN} w-full bg-white/[0.07]`}>Cancel</button>
      </div>
      <p className="text-xs text-muted-foreground">
        Nothing is removed on either side, except watch dates you choose to replace. A backup of your library is saved
        before anything changes.
      </p>
    </div>
  );
}

function Section({ icon, title, note, children }: { icon: React.ReactNode; title: string; note: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div>
        <h4 className="flex items-center gap-2 text-sm font-semibold">{icon}{title}</h4>
        <p className="text-xs text-muted-foreground">{note}</p>
      </div>
      {children}
    </div>
  );
}

/** One collapsible group per kind (Watched movies, Ratings...), with a tick for the whole group. */
function Kinds({ items, ticked, setMany }: { items: MirrorItem[]; ticked: Set<string>; setMany: (ids: string[], on: boolean) => void }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  return (
    <ul className="space-y-1.5">
      {KINDS.map(({ kind, label }) => {
        const these = items.filter((i) => i.kind === kind);
        if (!these.length) return null;
        const ids = these.map((i) => i.id);
        const on = ids.filter((id) => ticked.has(id)).length;
        const isOpen = open.has(kind) || these.length <= 3;
        return (
          <li key={kind} className="rounded-2xl bg-white/[0.07]">
            <div className="flex items-center gap-3 px-3.5 py-2.5">
              <input
                type="checkbox"
                aria-label={`All ${label.toLowerCase()}`}
                checked={on === ids.length}
                ref={(el) => {
                  if (el) el.indeterminate = on > 0 && on < ids.length;
                }}
                onChange={() => setMany(ids, on !== ids.length)}
                className="size-4 shrink-0 accent-[var(--primary)]"
              />
              <button
                type="button"
                disabled={these.length <= 3}
                onClick={() =>
                  setOpen((prev) => {
                    const next = new Set(prev);
                    if (next.has(kind)) next.delete(kind);
                    else next.add(kind);
                    return next;
                  })
                }
                className="flex min-w-0 flex-1 items-center justify-between gap-2 text-left"
              >
                <span className="text-sm font-medium">{label}</span>
                <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                  {on === ids.length ? these.length : `${on} of ${these.length}`}
                  {these.length > 3 && <ChevronDown className={`size-4 transition-transform ${isOpen ? "rotate-180" : ""}`} />}
                </span>
              </button>
            </div>
            {isOpen && (
              <ul className="space-y-0.5 px-2 pb-2">
                {these.map((i) => (
                  <li key={i.id}>
                    <label className="flex cursor-pointer items-center gap-3 rounded-xl px-1.5 py-1.5 hover:bg-white/[0.05]">
                      <input
                        type="checkbox"
                        checked={ticked.has(i.id)}
                        onChange={() => setMany([i.id], !ticked.has(i.id))}
                        className="size-4 shrink-0 accent-[var(--primary)]"
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-sm">{i.title}</span>
                        <span className="block text-xs text-muted-foreground">
                          {i.detail}
                          {i.when ? `${i.detail.includes("times") ? " · last" : ""} ${formatDateTimeAU(i.when)}` : ""}
                          {i.dates?.length ? `: ${datesText(i.dates)}` : ""}
                        </span>
                        {i.sentBefore && <span className="block text-xs text-amber-400">{sentText(i.sentBefore)}</span>}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Watch dates, short: "3 March 2023, 14:03", or the first one and how many more. */
function datesText(dates: (string | null)[]): string {
  const first = dates[0] ? formatDateTimeAU(dates[0]) : "date unknown";
  return dates.length > 1 ? `${first} + ${dates.length - 1} more` : first;
}

/** A title the two sides disagree on: what each has, and buttons to pick one. */
function DifferLine({ item, side, onPick }: { item: MirrorItem; side: Side | null; onPick: (s: Side | null) => void }) {
  const pill = (s: Side, label: string, value: string | undefined) => (
    <button
      type="button"
      onClick={() => onPick(side === s ? null : s)}
      aria-pressed={side === s}
      className={[
        "min-w-0 flex-1 rounded-2xl border px-3 py-1.5 text-center transition",
        side === s ? "border-primary/60 bg-primary/20 text-primary" : "border-border text-muted-foreground hover:text-foreground",
      ].join(" ")}
    >
      <span className="block truncate text-[11px] opacity-80">{label}</span>
      <span className="block text-sm font-semibold leading-tight">{value}</span>
    </button>
  );
  return (
    <li className="space-y-2 rounded-2xl bg-white/[0.07] px-3.5 py-2.5">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{item.title}</div>
        <div className="text-xs text-muted-foreground">{item.detail}</div>
      </div>
      <div className="flex gap-2">
        {pill("send", "Popcornhour", item.here ?? (item.hereDates ? datesText(item.hereDates) : undefined))}
        {pill("bring", "WeTrakr", item.there ?? (item.thereDates ? datesText(item.thereDates) : undefined))}
      </div>
    </li>
  );
}
