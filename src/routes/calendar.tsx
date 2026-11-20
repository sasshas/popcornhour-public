import { createFileRoute, Link } from "@tanstack/react-router";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ChevronLeft, ChevronRight, ExternalLink, Film, Loader2, Play, RefreshCw, ShoppingBag } from "lucide-react";
import { useScrollHide } from "@/lib/use-scroll-hide";
import { useShowTitles } from "@/hooks/use-show-titles";
import { STATUS_BAR_PX, useFullscreenMode } from "@/hooks/use-fullscreen-mode";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { getMovie, getReleaseCalendar, getWhenToStreamMonth } from "@/lib/tmdb.functions";
import { TrailerButton } from "@/components/media/TrailerButton";
import { img } from "@/lib/tmdb";
import { countryChoices, regionName, storeRegion } from "@/lib/region";
import { useAllCountries } from "@/hooks/use-all-countries";
import { useRegion } from "@/hooks/use-region";
import { FloatingSheet } from "@/components/ui/floating-sheet";
import { AddToListButton } from "@/components/media/AddToListButton";
import { WatchlistButton } from "@/components/media/WatchlistButton";
import { PosterBadges } from "@/components/media/PosterBadges";
import { PosterViewer } from "@/components/media/PosterViewer";
import { HERO_POSTER, nameHeroPoster, rememberPeek } from "@/lib/peek";
import {
  CALENDAR_KINDS, CALENDAR_MAX_YEAR, CALENDAR_MIN_YEAR, MONTH_NAMES,
  addMonths, clampMonth, currentMonth, dayKey, daysInMonth, firstWeekdayMonday, isCalendarKind,
  monthKey, parseMonthKey, type CalendarKind, type CalendarMonth,
} from "@/lib/release-calendar";

// /calendar?m=2026-11&k=streaming&f=svod&d=2026-11-06
//   m = month, k = streaming or in cinemas, f = (streaming only) just SVOD or just VOD, d = one chosen day.
// All are optional: no month means "this month".
type StreamFilter = "svod" | "vod";
type CalendarSearch = { m?: string; k?: CalendarKind; f?: StreamFilter; d?: string };

export const Route = createFileRoute("/calendar")({
  validateSearch: (s: Record<string, unknown>): CalendarSearch => ({
    m: parseMonthKey(s.m) ? (s.m as string) : undefined,
    k: isCalendarKind(s.k) ? s.k : undefined,
    f: s.f === "svod" || s.f === "vod" ? s.f : undefined,
    d: typeof s.d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s.d) ? s.d : undefined,
  }),
  head: () => ({ meta: [{ title: "Calendar — Popcornhour" }] }),
  component: CalendarPage,
});

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

type WtsMonth = Extract<Awaited<ReturnType<typeof getWhenToStreamMonth>>, { available: true }>;
type WtsEntry = WtsMonth["entries"][number];

/** One poster on the page, whichever source it came from. */
type Tile = {
  key: string;
  title: string;
  poster: string | null;
  tmdbId: number | null;
  /** Streaming calendar only: where it streams ("MGM+"), or "Digital" for rent/buy. */
  note?: string;
  /** Streaming calendar only: how it arrives that day, for the badge on the poster. */
  via?: "svod" | "vod";
  wts?: WtsEntry;
};

/**
 * The little label on a poster's top left corner: on a streaming service, or to rent / buy. (No backdrop blur: its
 * colour is nearly solid, so the blur was invisible, but one per poster made the page heavy to scroll.)
 */
function ViaBadge({ via }: { via: "svod" | "vod" }) {
  const svod = via === "svod";
  return (
    <span
      className={`pointer-events-none absolute -top-1.5 left-1.5 md:left-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] md:text-[11px] font-semibold leading-4 text-white shadow-md ring-1 ring-white/25 ${
        svod ? "bg-sky-500/90" : "bg-emerald-600/90"
      }`}
    >
      {svod ? <Play className="size-2.5 fill-current" /> : <ShoppingBag className="size-2.5" />}
      {svod ? "Streaming" : "Rent / buy"}
    </span>
  );
}

/** Whether the browser can animate the details panel (view transitions); without them it opens with its plain fade. */
const SHEET_SLIDES = typeof document !== "undefined" && "startViewTransition" in document;
/** The poster box on the page for a whentostream entry (marked with `data-cal` in DaySections). */
const tileBoxOf = (e: WtsEntry) => document.querySelector<HTMLElement>(`[data-cal="${CSS.escape(`${e.day}|${e.slug}`)}"]`);
/** The picture a tile and the details panel both show: TMDB's poster when the movie is matched (always 2:3), else whentostream's. */
const posterOf = (e: WtsEntry) => (e.tmdbPoster ? img(e.tmdbPoster, "w342") : e.poster);
/** Lets React finish taking the panel off (or putting it on) the page before the browser pictures the new state. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

function todayKey(): string {
  const d = new Date();
  return dayKey({ year: d.getFullYear(), month: d.getMonth() + 1 }, d.getDate());
}

/** The Monday of the current week, as a "2026-11-09" key (the calendar's weeks run Monday to Sunday). */
function weekStartKey(): string {
  const d = new Date();
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return dayKey({ year: d.getFullYear(), month: d.getMonth() + 1 }, d.getDate());
}

/** "Fri 6 Nov" for a "2026-11-06" key. */
function dayLabel(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][wd]} ${d} ${MONTH_NAMES[m - 1].slice(0, 3)}`;
}

/** "6 Nov 2026" for a "2026-11-06" key (written out by hand so the time zone can't move the day). */
function dateLong(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return `${d} ${MONTH_NAMES[m - 1].slice(0, 3)} ${y}`;
}

/** How an entry reaches you on its listed day: on a streaming service (SVOD) or to rent/buy (VOD). */
function releaseTypeOn(e: WtsEntry): "svod" | "vod" | null {
  if (e.details?.svodDate === e.day) return "svod";
  if (e.details?.vodDate === e.day) return "vod";
  return null;
}

/**
 * The days and their posters. Memoised: scrolling makes the controls bar hide and show, which redraws the page around
 * this list; without the memo every poster in the month was redrawn each time, which made scrolling feel heavy.
 */
const DaySections = memo(function DaySections({
  days, shownDays, today, showTitles, onOpen,
}: {
  days: Record<string, Tile[]>;
  shownDays: string[];
  today: string;
  showTitles: boolean;
  onOpen: (entry: WtsEntry) => void;
}) {
  return (
    <>
    {shownDays.map((day) => (
      <section key={day} id={`day-${day}`} aria-label={dayLabel(day)} className="scroll-mt-[var(--jump-top,0px)] md:scroll-mt-4">
        <h2 className="mb-3 text-base md:text-lg font-semibold">
          {dayLabel(day)}
          {day === today && <span className="ml-2 text-xs font-medium text-primary">Today</span>}
        </h2>
        <div className="grid grid-cols-3 md:grid-cols-5 lg:grid-cols-6 gap-x-3 gap-y-4">
          {days[day].map((t) => {
            const inner = (
              <>
                <div className="relative">
                <div data-cal={t.wts ? t.key : undefined} className="aspect-[2/3] overflow-hidden rounded-xl bg-surface ring-1 ring-border">
                  {t.poster ? (
                    <img src={t.poster} alt={t.title} loading="lazy" className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.04]" />
                  ) : (
                    <div className="grid h-full w-full place-items-center text-muted-foreground"><Film className="size-8" /></div>
                  )}
                </div>
                {/* On your watchlist / watched / in one of your lists, like the Library's poster grid. */}
                {t.tmdbId && <PosterBadges mediaType="movie" tmdbId={t.tmdbId} statusOnly />}
                {/* Top left: how it arrives (streaming service, or rent / buy). */}
                {t.via && <ViaBadge via={t.via} />}
                </div>
                {showTitles && <p className="mt-2 px-0.5 text-sm font-medium line-clamp-2">{t.title}</p>}
                {t.note && <p className={`px-0.5 text-xs text-muted-foreground line-clamp-1 ${showTitles ? "" : "mt-1.5"}`}>{t.note}</p>}
              </>
            );
            // whentostream titles open their details; TMDB-only titles go straight to the movie page.
            return t.wts ? (
              <button key={t.key} onClick={() => onOpen(t.wts!)} className="group block text-left">
                {inner}
              </button>
            ) : (
              <Link key={t.key} to="/movie/$id" params={{ id: String(t.tmdbId) }} className="group block">
                {inner}
              </Link>
            );
          })}
        </div>
      </section>
    ))}
    </>
  );
});

function CalendarPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const region = useRegion(); // null until the browser's saved country is known
  const allCountries = useAllCountries(); // Settings > Appearance: otherwise the country dropdown lists just the top few

  const cur = useMemo(() => currentMonth(), []);
  const month = parseMonthKey(search.m) ?? cur;
  const kind: CalendarKind = search.k ?? "streaming";
  const filter: StreamFilter | undefined = kind === "streaming" ? search.f : undefined;
  const mKey = monthKey(month);
  const selectedDay = search.d && search.d.startsWith(mKey) ? search.d : undefined;
  const today = todayKey();
  const [open, setOpen] = useState<WtsEntry | null>(null);
  // Tapping a poster: the details panel slides up from the bottom while the tapped poster flies into it; closing
  // plays it backwards. The poster carries the animation name only for the moment the browser pictures the page
  // (before: on the tile, after: on the panel's poster), because two elements with the name cancel the animation.
  const openSheet = useCallback((entry: WtsEntry) => {
    const box = tileBoxOf(entry);
    if (!SHEET_SLIDES || !box) return setOpen(entry);
    nameHeroPoster(box);
    document.startViewTransition(async () => {
      box.style.removeProperty("view-transition-name");
      flushSync(() => setOpen(entry));
      await settle();
    });
  }, []);
  const closeSheet = () => {
    const box = open ? tileBoxOf(open) : null;
    if (!SHEET_SLIDES || !box) return setOpen(null);
    const t = document.startViewTransition(async () => {
      flushSync(() => setOpen(null));
      await settle();
      nameHeroPoster(box);
    });
    t.finished.finally(() => box.style.removeProperty("view-transition-name"));
  };
  // "Open in Popcornhour": the panel goes at once and the tile takes the name, so the page-change animation grows
  // the tile's poster into the movie page's (the movie page also shows the title and poster straight away).
  const leaveForMovie = () => {
    const entry = open;
    flushSync(() => setOpen(null));
    if (!entry) return;
    if (entry.tmdbId) rememberPeek("movie", entry.tmdbId, { title: entry.title, posterPath: entry.tmdbPoster });
    const box = tileBoxOf(entry);
    if (box) nameHeroPoster(box);
  };
  const showTitles = useShowTitles("calendar"); // Settings > Appearance

  const qc = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [gridOpen, setGridOpen] = useState(false); // the month grid starts folded away (more posters on screen); "Show grid" opens it

  // 1. whentostream.com's own calendar for this month.
  const fetchWts = useServerFn(getWhenToStreamMonth);
  const wtsQuery = useQuery({
    queryKey: ["wts-month", kind, mKey],
    queryFn: () => fetchWts({ data: { year: month.year, month: month.month, kind } }),
    staleTime: 1000 * 60 * 30,
    placeholderData: keepPreviousData,
  });
  const wts = wtsQuery.data && "entries" in wtsQuery.data && wtsQuery.data.year === month.year && wtsQuery.data.month === month.month && wtsQuery.data.kind === kind
    ? wtsQuery.data
    : undefined;
  const wtsMissing = !!wtsQuery.data && !wtsQuery.isPlaceholderData && !wtsQuery.data.available;

  // 2. Only when that site has no calendar for the month (it keeps recent and upcoming months): TMDB's dates.
  const fetchTmdb = useServerFn(getReleaseCalendar);
  const tmdbQuery = useQuery({
    queryKey: ["release-calendar", region, kind, mKey],
    queryFn: () => fetchTmdb({ data: { year: month.year, month: month.month, kind, region: region! } }),
    enabled: wtsMissing && region !== null,
    staleTime: 1000 * 60 * 30,
    placeholderData: keepPreviousData,
  });
  const tmdb = wtsMissing && tmdbQuery.data && tmdbQuery.data.year === month.year && tmdbQuery.data.month === month.month && tmdbQuery.data.kind === kind
    ? tmdbQuery.data
    : undefined;

  // The Refresh button: read this month again from the source now, instead of using what the server has kept.
  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      if (wtsMissing) {
        if (region === null) return;
        const fresh = await fetchTmdb({ data: { year: month.year, month: month.month, kind, region, refresh: true } });
        qc.setQueryData(["release-calendar", region, kind, mKey], fresh);
      } else {
        const fresh = await fetchWts({ data: { year: month.year, month: month.month, kind, refresh: true } });
        qc.setQueryData(["wts-month", kind, mKey], fresh);
      }
    } catch {
      // keep showing what is already on screen
    } finally {
      setRefreshing(false);
    }
  };

  // Everything as { day -> tiles }, filtered.
  const days = useMemo<Record<string, Tile[]> | undefined>(() => {
    if (wts) {
      const out: Record<string, Tile[]> = {};
      for (const e of wts.entries) {
        const type = releaseTypeOn(e);
        if (filter && type !== filter) continue;
        const platform = type === "svod" ? e.details?.svodPlatform : e.details?.vodPlatform;
        (out[e.day] ??= []).push({
          key: `${e.day}|${e.slug}`,
          title: e.title,
          // TMDB's poster when we have matched the movie (all the same 2:3 shape); whentostream's picture otherwise.
          poster: posterOf(e),
          tmdbId: e.tmdbId,
          // The line under the title: the service it streams on, or "Rent / buy" (the badge on the poster says the same).
          note: kind === "streaming" ? (type === "svod" ? (platform ?? "Streaming") : type === "vod" ? "Rent / buy" : undefined) : undefined,
          via: kind === "streaming" && type ? type : undefined,
          wts: e,
        });
      }
      return out;
    }
    if (tmdb) {
      const out: Record<string, Tile[]> = {};
      for (const [day, list] of Object.entries(tmdb.days)) {
        out[day] = list.map((m) => ({ key: `${day}|${m.id}`, title: m.title ?? "Untitled", poster: img(m.poster_path, "w342"), tmdbId: m.id }));
      }
      return out;
    }
    return undefined;
  }, [wts, tmdb, filter, kind]);

  const go = (next: Partial<CalendarSearch>) =>
    // viewTransition false: these only change what the Calendar shows, so the page-change fade must not play.
    navigate({ search: (prev) => ({ ...prev, ...next }), replace: true, resetScroll: false, viewTransition: false });
  // Tapping a day shows just that day, and scrolls down to it (the month grid is above it).
  // "Today" / "This week": go to this month if needed, then scroll to the first day that has movies from today
  // (or from the start of this week, Monday) onwards.
  const [wantJump, setWantJump] = useState<"today" | "week" | null>(null);
  // The phone's controls bar slides away while scrolling down and returns on scroll up. A jump to a day keeps it
  // showing (the page scrolling by itself must not hide it), and the day heading stops just below it (the section's
  // scroll margin is the bar's measured height), so the bar never covers the date.
  const { hidden: barHidden, scrolled, instant: barInstant, hold } = useScrollHide("calendar");
  const fullscreen = useFullscreenMode(); // Settings > Appearance
  const barRef = useRef<HTMLDivElement>(null);
  const [barH, setBarH] = useState(0);
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const read = () => setBarH(el.offsetHeight);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const scrollToDay = (key: string) => {
    // Fullscreen: the bar folds away for the jump. Otherwise it stays, and the date stops just below it.
    hold(10000, fullscreen); // until you touch or scroll yourself (or 10 seconds)
    setTimeout(() => document.getElementById(`day-${key}`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
  };
  const jumpTo = (what: "today" | "week") => {
    if (mKey !== monthKey(cur) || selectedDay) go({ m: monthKey(cur), d: undefined });
    setWantJump(what);
  };
  useEffect(() => {
    if (!wantJump || mKey !== monthKey(cur) || !days || selectedDay) return;
    const from = wantJump === "today" ? today : weekStartKey();
    const sorted = Object.keys(days).sort();
    const target = sorted.find((d) => d >= from) ?? sorted.pop();
    setWantJump(null);
    if (target) scrollToDay(target);
  }, [wantJump, mKey, cur, days, selectedDay, today]);

  const pickDay = (key: string | undefined) => {
    go({ d: key });
    if (key) scrollToDay(key);
  };
  const goMonth = (m: { year: number; month: number }) => {
    const c = clampMonth(m);
    go({ m: monthKey(c), d: undefined });
  };

  const total = days ? Object.values(days).reduce((n, list) => n + list.length, 0) : 0;
  const blanks = firstWeekdayMonday(month);
  const dayCount = daysInMonth(month);
  // Kept the same from one draw to the next (useMemo), so the poster list below is not redrawn when only the bar changes.
  const listedDays = useMemo(() => (days ? Object.keys(days).sort() : []), [days]);
  const shownDays = useMemo(() => (selectedDay ? listedDays.filter((d) => d === selectedDay) : listedDays), [listedDays, selectedDay]);
  const loading = !days && !wtsQuery.isError && (wtsQuery.isLoading || wtsQuery.isFetching || (wtsMissing && (region === null || tmdbQuery.isLoading)));
  const fetching = wtsQuery.isFetching || tmdbQuery.isFetching;
  const failed = !days && (wtsQuery.isError || (wtsMissing && tmdbQuery.isError));

  const kindPill = (active: boolean) =>
    `rounded-full border px-3 py-1.5 text-xs md:text-sm whitespace-nowrap transition ${
      active ? "border-primary/50 bg-primary/20 text-primary" : "border-border bg-surface text-foreground hover:border-primary/50"
    }`;

  return (
    <div
      className="px-4 md:px-10 pb-4 md:py-10 space-y-5 max-w-5xl mx-auto"
      // How far from the top of the screen a jumped-to date stops: below the Android status bar in fullscreen,
      // otherwise just below the controls bar (which stays showing).
      style={{ "--jump-top": fullscreen ? `${STATUS_BAR_PX}px` : `calc(${barH}px + 0.5rem)` } as React.CSSProperties}
    >
      {/* The controls. On a phone this is the page's top bar (the app's own bar is hidden here): it sticks to the top,
          folds away while you scroll down and comes back as see-through glass when you scroll up. */}
      <div
        ref={barRef}
        data-scrolled={scrolled || undefined}
        className={[
          // .page-bar (styles.css): see-through with no edge at the top of the page, tinted glass once it has scrolled.
          "page-bar space-y-3",
          "max-md:sticky max-md:top-0 max-md:z-30 max-md:-mx-4 max-md:origin-top max-md:px-4 max-md:pb-3",
          "max-md:pt-[max(0.75rem,env(safe-area-inset-top))]",
          barInstant ? "max-md:transition-none" : "max-md:transition-[clip-path,opacity,background-color] max-md:duration-[350ms]",
          barHidden
            ? "max-md:pointer-events-none max-md:[clip-path:inset(0_0_100%_0)] max-md:opacity-0 max-md:ease-in"
            : "max-md:[clip-path:inset(0)] max-md:opacity-100 max-md:ease-out",
        ].join(" ")}
      >
        <h1 className="hidden md:block text-4xl font-bold tracking-tight">Release calendar</h1>

        <div className="flex flex-wrap items-center gap-2">
          {(Object.keys(CALENDAR_KINDS) as CalendarKind[]).map((k) => (
            <button key={k} onClick={() => go({ k, f: undefined, d: undefined })} className={kindPill(k === kind)}>
              {CALENDAR_KINDS[k].label}
            </button>
          ))}
          {/* Top right, a full-size round button well away from the Today / This week links, so it is not pressed by accident. */}
          <button
            onClick={refresh}
            disabled={refreshing}
            aria-label="Refresh this month"
            title="Read this month again from the source"
            className="ml-auto grid size-10 shrink-0 place-items-center rounded-full border border-border bg-surface text-muted-foreground transition active:bg-white/10 md:hover:text-foreground disabled:opacity-80"
          >
            <RefreshCw className={"size-[18px] " + (refreshing || fetching ? "animate-spin" : "")} />
          </button>
        </div>
        {kind === "streaming" && (
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => go({ f: undefined, d: undefined })} className={kindPill(!filter)}>All</button>
            <button onClick={() => go({ f: "svod", d: undefined })} className={kindPill(filter === "svod")}>Streaming services</button>
            <button onClick={() => go({ f: "vod", d: undefined })} className={kindPill(filter === "vod")}>Rent / buy</button>
          </div>
        )}

        {/* Month pagination: previous / "November 2026" / next. Tapping the month or year opens a picker for both. */}
        <div className="mx-auto flex w-full max-w-xs items-center rounded-full border border-border bg-surface/80 p-1">
          <button
            onClick={() => goMonth(addMonths(month, -1))}
            aria-label="Previous month"
            className="grid size-10 shrink-0 place-items-center rounded-full active:bg-white/10 md:hover:bg-white/10"
          >
            <ChevronLeft className="size-5" />
          </button>
          <MonthPicker month={month} onPick={goMonth} />
          <button
            onClick={() => goMonth(addMonths(month, 1))}
            aria-label="Next month"
            className="grid size-10 shrink-0 place-items-center rounded-full active:bg-white/10 md:hover:bg-white/10"
          >
            <ChevronRight className="size-5" />
          </button>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground min-h-5">
          <span>
            {days ? `${total} movie${total === 1 ? "" : "s"}` : " "}
          </span>
          <span className="flex items-center gap-3">
            <button onClick={() => jumpTo("today")} className="whitespace-nowrap underline underline-offset-4 hover:text-foreground">
              Today
            </button>
            <button onClick={() => jumpTo("week")} className="whitespace-nowrap underline underline-offset-4 hover:text-foreground">
              This week
            </button>
            <button onClick={() => setGridOpen((v) => !v)} className="whitespace-nowrap underline underline-offset-4 hover:text-foreground">
              {gridOpen ? "Hide grid" : "Show grid"}
            </button>
          </span>
        </div>

        {tmdb && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>whentostream.com doesn't list this month, so these are TMDB's dates for</span>
            <select
              aria-label="Country"
              value={region ?? "US"}
              onChange={(e) => storeRegion(e.target.value)}
              className="bg-surface border border-border rounded-md px-2 py-1 text-xs text-foreground outline-none focus:border-primary"
            >
              {countryChoices(region ?? "US", allCountries).map(([c, n]) => <option key={c} value={c}>{n}</option>)}
            </select>
            <span className="sr-only">{regionName(region ?? "US")}</span>
          </div>
        )}
      </div>

      {/* The month: a number per day, with how many movies come out that day. Tap a day to see only that day. */}
      <div className={`grid grid-cols-7 gap-1 md:gap-2 transition-opacity ${gridOpen ? "" : "hidden"} ${days ? "" : "opacity-50"}`}>
        {WEEKDAYS.map((w) => (
          <div key={w} className="pb-1 text-center text-[10px] md:text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {w}
          </div>
        ))}
        {Array.from({ length: blanks }, (_, i) => <div key={`b${i}`} />)}
        {Array.from({ length: dayCount }, (_, i) => {
          const key = dayKey(month, i + 1);
          const count = days?.[key]?.length ?? 0;
          const selected = key === selectedDay;
          return (
            <button
              key={key}
              disabled={count === 0}
              onClick={() => pickDay(selected ? undefined : key)}
              aria-pressed={selected}
              aria-label={`${dayLabel(key)}: ${count} movie${count === 1 ? "" : "s"}`}
              className={[
                // Short cells on a phone so the whole month takes up a fraction of the screen and the posters start sooner.
                "relative flex h-10 flex-col items-center justify-center rounded-lg border text-xs md:aspect-[4/3] md:h-auto md:items-start md:justify-start md:p-2 md:text-sm transition",
                selected
                  ? "border-primary bg-primary/20"
                  : key === today
                    ? "border-primary/50 bg-surface"
                    : "border-border bg-surface/60",
                count > 0 ? "hover:border-primary/60" : "text-muted-foreground/50",
              ].join(" ")}
            >
              <span className="font-medium leading-none">{i + 1}</span>
              {count > 0 && (
                <span className="mt-0.5 rounded-full bg-primary/25 px-1.5 text-[9px] leading-[14px] font-semibold text-primary md:mt-auto md:self-end md:text-xs md:leading-normal">
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {selectedDay && (
        <button onClick={() => go({ d: undefined })} className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground">
          Show the whole month
        </button>
      )}

      {failed ? (
        <div className="space-y-3">
          <p className="font-medium text-destructive">Couldn't load this month.</p>
          <button
            onClick={() => { wtsQuery.refetch(); if (wtsMissing) tmdbQuery.refetch(); }}
            className="rounded-full border border-border bg-surface px-4 py-2 text-sm font-medium hover:bg-surface-elevated"
          >
            Try again
          </button>
        </div>
      ) : loading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading… (a month that hasn't been opened yet can take a few seconds)
        </p>
      ) : days && listedDays.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing listed for this month{filter ? " with this filter" : ""}.</p>
      ) : (
        <div className={`space-y-6 transition-opacity ${days ? "" : "opacity-50"}`}>
          <DaySections days={days!} shownDays={shownDays} today={today} showTitles={showTitles} onOpen={openSheet} />
        </div>
      )}

      {wts && days && listedDays.length > 0 && (
        <p className="text-xs text-muted-foreground">Dates and details from whentostream.com (US release dates).</p>
      )}

      <DetailsSheet entry={open} onClose={closeSheet} onLeave={leaveForMovie} />
    </div>
  );
}

/** The month and year as one button; opens a window with the 12 months and a row of years to pick from. */
function MonthPicker({ month, onPick }: { month: CalendarMonth; onPick: (m: CalendarMonth) => void }) {
  const [open, setOpen] = useState(false);
  // The first of the five years shown. Starts so the chosen year is in the middle; the arrows move it by five.
  const windowStart = (y: number) => Math.min(Math.max(y - 2, CALENDAR_MIN_YEAR), CALENDAR_MAX_YEAR - 4);
  const [base, setBase] = useState(windowStart(month.year));
  const years = Array.from({ length: 5 }, (_, i) => base + i);

  const pill = (on: boolean) =>
    "h-10 rounded-full text-sm font-medium transition " +
    (on ? "bg-primary text-primary-foreground" : "hover:bg-surface-elevated");

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setBase(windowStart(month.year));
      }}
    >
      <PopoverTrigger asChild>
        <button className="flex-1 truncate rounded-full px-2 py-2 text-center text-base font-semibold active:bg-white/10 md:hover:bg-white/10" aria-label="Pick month and year">
          {MONTH_NAMES[month.month - 1]} {month.year}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={10}
        className="w-[min(22rem,calc(100vw-2rem))] rounded-2xl p-3"
        // A solid panel: the liquid-glass style makes popovers see-through, which is hard to read over the poster list.
        style={{ backgroundColor: "var(--card)", backgroundImage: "none", backdropFilter: "none", WebkitBackdropFilter: "none" }}
      >
        <div className="grid grid-cols-3 gap-1">
          {MONTH_NAMES.map((n, i) => (
            <button
              key={n}
              onClick={() => {
                onPick({ year: month.year, month: i + 1 });
                setOpen(false);
              }}
              className={pill(i + 1 === month.month)}
            >
              {n.slice(0, 3)}
            </button>
          ))}
        </div>
        <div className="my-3 border-t border-border" />
        <div className="mb-1 flex items-center justify-between px-1 text-sm text-muted-foreground">
          <span>Year</span>
          <span className="flex items-center gap-1">
            <button
              aria-label="Earlier years"
              disabled={base <= CALENDAR_MIN_YEAR}
              onClick={() => setBase((b) => Math.max(b - 5, CALENDAR_MIN_YEAR))}
              className="grid size-7 place-items-center rounded-full hover:bg-surface-elevated disabled:opacity-30"
            >
              <ChevronLeft className="size-4" />
            </button>
            <button
              aria-label="Later years"
              disabled={base + 4 >= CALENDAR_MAX_YEAR}
              onClick={() => setBase((b) => Math.min(b + 5, CALENDAR_MAX_YEAR - 4))}
              className="grid size-7 place-items-center rounded-full hover:bg-surface-elevated disabled:opacity-30"
            >
              <ChevronRight className="size-4" />
            </button>
          </span>
        </div>
        <div className="grid grid-cols-5 gap-1">
          {years.map((y) => (
            <button key={y} onClick={() => onPick({ year: y, month: month.month })} className={pill(y === month.year) + " px-0"}>
              {y}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** What whentostream.com says about one movie, with a link to our own movie page when we know which movie it is. */
function DetailsSheet({ entry, onClose, onLeave }: { entry: WtsEntry | null; onClose: () => void; onLeave: () => void }) {
  // Keep the last entry while the sheet fades out.
  const [last, setLast] = useState<WtsEntry | null>(null);
  if (entry && entry !== last) setLast(entry);
  const e = entry ?? last;
  const d = e?.details;
  // The poster shown big (PosterViewer) after a tap on the panel's poster.
  const posterButton = useRef<HTMLButtonElement>(null);
  const [big, setBig] = useState(false);

  // The trailer comes from TMDB (the same movie lookup the movie page uses, so it is shared if you open it too).
  const tmdbId = e?.tmdbId ?? null;
  const { data: movie } = useQuery({
    queryKey: ["movie", tmdbId],
    queryFn: () => getMovie({ data: { id: tmdbId! } }),
    enabled: !!entry && tmdbId !== null,
    staleTime: 1000 * 60 * 30,
  });
  const videos = movie?.videos?.results ?? [];
  const trailer = videos.find((v) => v.site === "YouTube" && v.type === "Trailer" && v.official)
    ?? videos.find((v) => v.site === "YouTube" && v.type === "Trailer");

  const rows: [string, string | null | undefined][] = e
    ? [
        ["Rating", d?.rating],
        ["Runtime", d?.runtime],
        ["Genre", d?.genres],
        ["Director", d?.director],
        ["Cast", d?.cast],
        ["Distributor", d?.distributor],
        ["In cinemas", d?.theaterDate ? dateLong(d.theaterDate) : null],
        ["Rent / buy", d?.vodDate ? `${dateLong(d.vodDate)}${d.vodPlatform ? ` (${d.vodPlatform})` : ""}` : null],
        ["Streaming", d?.svodDate ? `${dateLong(d.svodDate)}${d.svodPlatform ? ` (${d.svodPlatform})` : ""}` : null],
      ]
    : [];

  return (
    <FloatingSheet open={!!entry} onOpenChange={(o) => { if (!o) onClose(); }} title={e?.title ?? ""} slides={SHEET_SLIDES}>
      {e && (
        <div className="max-h-[65dvh] space-y-4 overflow-y-auto">
          <div className="flex gap-4">
            {/* Poster, with the trailer button tucked under it (the details beside it are taller, so it adds no height). */}
            <div className="w-24 shrink-0 space-y-2 self-start">
              {/* The same picture as the tapped tile, so it is already loaded and the tile can fly into it (openSheet).
                  Tapping it shows it big, like the poster on a movie page. */}
              {posterOf(e) && (
                <button
                  ref={posterButton}
                  type="button"
                  onClick={() => setBig(true)}
                  aria-label="Enlarge poster"
                  className="block w-full cursor-zoom-in rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <img
                    src={posterOf(e)!}
                    alt=""
                    style={{ viewTransitionName: HERO_POSTER }}
                    className="block aspect-[2/3] w-full rounded-xl bg-surface object-cover ring-1 ring-border"
                  />
                </button>
              )}
              {/* Beside the button, not in it: clicks inside the viewer would otherwise reach the button and reopen it. */}
              {big && (
                <PosterViewer
                  path={e.tmdbPoster ?? null}
                  src={posterOf(e) ?? undefined}
                  alt={e.title}
                  source={posterButton}
                  onClosed={() => setBig(false)}
                />
              )}
              {trailer && <TrailerButton youtubeKey={trailer.key} label="Trailer" compact inDialog />}
            </div>
            <dl className="min-w-0 flex-1 space-y-1.5 text-sm">
              {rows.filter(([, v]) => v).map(([k, v]) => (
                <div key={k}>
                  <dt className="inline text-muted-foreground">{k}: </dt>
                  <dd className="inline">{v}</dd>
                </div>
              ))}
              {!d && <p className="text-muted-foreground">Couldn't read this movie's page on whentostream.com.</p>}
            </dl>
          </div>
          {d?.synopsis && <p className="text-sm leading-relaxed text-muted-foreground">{d.synopsis}</p>}
          {/* Only for a movie we could match to TMDB (that is what the library and lists are keyed on). */}
          {e.tmdbId && (
            <div className="flex flex-wrap gap-2">
              <WatchlistButton
                tmdbId={e.tmdbId}
                title={e.title}
                posterPath={e.tmdbPoster}
                releaseDate={e.tmdbDate ?? d?.theaterDate ?? null}
              />
              <AddToListButton
                mediaType="movie"
                tmdbId={e.tmdbId}
                title={e.title}
                posterPath={e.tmdbPoster}
                releaseDate={e.tmdbDate ?? d?.theaterDate ?? null}
              />
            </div>
          )}
          <div className="flex flex-wrap gap-2 pb-1">
            {e.tmdbId && (
              <Link
                to="/movie/$id"
                params={{ id: String(e.tmdbId) }}
                onClick={onLeave}
                className="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
              >
                Open in Popcornhour
              </Link>
            )}
            <a
              href={`https://whentostream.com/${e.slug}/`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-4 py-2 text-sm font-medium hover:bg-surface-elevated"
            >
              whentostream.com <ExternalLink className="size-3.5" />
            </a>
          </div>
        </div>
      )}
    </FloatingSheet>
  );
}
