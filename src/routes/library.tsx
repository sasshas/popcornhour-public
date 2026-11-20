import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  Heart,
  ArrowDown,
  ArrowUp,
  Calendar,
  CalendarCheck,
  Type,
  Star,
  Film,
  Clapperboard,
  MonitorPlay,
  Tv as TvIcon,
  RadioTower,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { FilterButton, FiltersSheet, genreCounts, pickedGenresLabel, withGenres } from "@/components/media/FiltersSheet";
import { useRegion } from "@/hooks/use-region";
import { listLibrary } from "@/lib/library.functions";
import { getMoviesAvailability } from "@/lib/tmdb.functions";
import { useAuth } from "@/hooks/use-auth";
import { img } from "@/lib/tmdb";
import { APP_SCROLL_SELECTOR } from "@/lib/use-scroll-hide";
import { PosterBadges } from "@/components/media/PosterBadges";
import { useTmdbInfo } from "@/hooks/use-tmdb-scores";
import { useShowTitles } from "@/hooks/use-show-titles";
import { useRtScores } from "@/hooks/use-rt-scores";
import { useLastAired } from "@/hooks/use-last-aired";
import { StickyControls } from "@/components/layout/StickyControls";
import { markHeroPoster, rememberPeek } from "@/lib/peek";
import { LoadMore } from "@/components/media/LoadMore";
import { isFreshVisit } from "@/lib/nav-action";

/** Posters drawn at a time in a big view (see `more` in the page). About ten rows on a phone. */
const PAGE_SIZE = 30;

/**
 * What the Library was last showing, kept for as long as the app stays open in this browser tab. Opening a movie
 * removes the Library from the page; without this, coming Back started it again on the default tab with one page of
 * posters, so the place you had scrolled to was gone. Only ever written in the browser (inside effects).
 */
let lastView: {
  kind: "movie" | "tv";
  movieFilter: string;
  tvFilter: string;
  sortMap: Record<string, { sortKey: string; sortDir: "asc" | "desc" }>;
  more: { key: string; n: number };
  cinemaCounts: boolean;
  genreFilter: GenreFilter;
  /** The browser-history entry the Library was on. Back returns to the same entry; a fresh visit is a new one. */
  entry: string | undefined;
} | null = null;

/** The router's id for the browser-history entry now showing. */
function historyEntry(): string | undefined {
  return typeof window === "undefined" ? undefined : (window.history.state?.__TSR_key as string | undefined);
}

/** A copy of the first `count` posters of a drawn grid, as HTML (null when there is nothing to copy). */
function snapshotOf(grid: Element | null, count: number, dir: "left" | "right") {
  if (!grid) return null;
  const copy = grid.cloneNode(false) as HTMLElement;
  for (const child of Array.from(grid.children).slice(0, count)) copy.appendChild(child.cloneNode(true));
  copy.querySelectorAll("img").forEach((img) => img.setAttribute("loading", "eager")); // already loaded: show at once
  return { html: copy.outerHTML, dir };
}

type LibraryRow = Awaited<ReturnType<typeof listLibrary>>[number];

/**
 * Filter > Genres: the genres picked on each tab (movies and shows have different TMDB genres). A title shows when it
 * has any of them; none picked shows everything.
 */
type GenreFilter = { movie: string[]; tv: string[] };
const NO_GENRES: GenreFilter = { movie: [], tv: [] };

/** A saved genre choice, or nothing when it is not the right shape. */
function readGenreFilter(v: unknown): GenreFilter | null {
  if (!v || typeof v !== "object") return null;
  const list = (x: unknown) => (Array.isArray(x) ? x.filter((g): g is string => typeof g === "string") : []);
  return { movie: list((v as GenreFilter).movie), tv: list((v as GenreFilter).tv) };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/**
 * "2 Apr" for a date this year, "2 Apr 2027" otherwise. Release dates arrive as midnight UTC, so the day is read in
 * UTC: reading it in local time would show the day before in timezones behind UTC.
 */
function shortDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const year = d.getUTCFullYear();
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${year === new Date().getFullYear() ? "" : ` ${year}`}`;
}

/**
 * One poster in the grid. Memoised: it is only drawn again when something about this poster changes, not every time
 * the page around it does (another page of posters being added used to re-run every poster already on the page).
 */
const PosterTile = memo(function PosterTile({
  it,
  showTitles,
  score,
  releaseDate,
  releaseKind,
  eager,
}: {
  it: LibraryRow;
  showTitles: boolean;
  score: number | null;
  /** Shown as a small date badge (movies Upcoming only): the digital date once there is one, else the cinema date. */
  releaseDate: string | null;
  releaseKind: "digital" | "cinema";
  /** Load the picture straight away instead of when it nears the screen. */
  eager: boolean;
}) {
  return (
    <Link
      to={it.media_type === "movie" ? "/movie/$id" : "/tv/$id"}
      params={{ id: String(it.tmdb_id) }}
      className="group"
      // Lets the page being opened show this poster and title at once, while its details load.
      onClick={(e) => {
        rememberPeek(it.media_type, it.tmdb_id, { title: it.title, posterPath: it.poster_path, backdropPath: it.backdrop_path });
        markHeroPoster(e.currentTarget);
      }}
      title={showTitles ? undefined : it.title} // hover tooltip + accessible name when the caption is hidden
      aria-label={showTitles ? undefined : it.title}
    >
      <div className="relative">
        <div data-hero={`${it.media_type}:${it.tmdb_id}`} className="relative aspect-[2/3] rounded-xl overflow-hidden bg-surface ring-1 ring-border">
          {it.poster_path ? (
            <img src={img(it.poster_path, "w342")!} alt={it.title} loading={eager ? "eager" : "lazy"} className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" />
          ) : (
            <div className="w-full h-full grid place-items-center text-xs text-muted-foreground p-2 text-center">{it.title}</div>
          )}
          {it.favorite && (
            <div className="absolute bottom-2 right-2 size-7 grid place-items-center rounded-full bg-background/90 text-[var(--gold)]">
              <Heart className="size-3.5 fill-current" />
            </div>
          )}
        </div>
        <PosterBadges
          mediaType={it.media_type}
          tmdbId={it.tmdb_id}
          score={score}
          bottomLeft={
            releaseDate && (
              // A small dark pill in the bottom-left corner, just above the streaming logos when the poster has any.
              <div
                className="flex items-center gap-1 rounded-full bg-black/70 py-0.5 pl-1.5 pr-2 text-[11px] font-semibold leading-4 text-white ring-1 ring-white/15 whitespace-nowrap"
                title={`${releaseKind === "digital" ? "Digital" : "Cinema"} release ${shortDate(releaseDate)}`}
              >
                {releaseKind === "digital" ? (
                  <MonitorPlay className="size-3 text-[var(--gold)]" aria-hidden />
                ) : (
                  <Clapperboard className="size-3 text-sky-300" aria-hidden />
                )}
                <span className="sr-only">{releaseKind === "digital" ? "Digital" : "Cinema"} release </span>
                {shortDate(releaseDate)}
              </div>
            )
          }
        />
      </div>
      {showTitles && <p className="mt-2 text-sm font-medium line-clamp-1">{it.title}</p>}
    </Link>
  );
});

export const Route = createFileRoute("/library")({
  head: () => ({ meta: [{ title: "Library — Popcornhour" }] }),
  component: LibraryPage,
});

const MOVIE_FILTERS = [
  { value: "unwatched", label: "Unwatched" },
  { value: "upcoming", label: "Upcoming" },
  { value: "watched", label: "Watched" },
  { value: "favorites", label: "Favourites" },
] as const;

const TV_FILTERS = [
  { value: "watching", label: "Watching" },
  { value: "plan_to_watch", label: "Watchlist" },
  { value: "completed", label: "Watched" },
  { value: "on_hold", label: "Paused" },
  { value: "dropped", label: "Dropped" },
] as const;

// "rt" is the Rotten Tomatoes critics' score (the % on the posters). It replaced "Personal rating"; a pill whose
// remembered sort was that falls back to its default.
// "aired" (Recently aired) orders shows by when their latest episode went out; TV only.
type SortKey = "added" | "name" | "rt" | "release" | "watched" | "aired";
const SORTS: { value: SortKey; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { value: "added", label: "Date added", icon: Calendar },
  { value: "name", label: "Name", icon: Type },
  { value: "rt", label: "Rotten Tomatoes", icon: Star },
  { value: "release", label: "Release date", icon: Calendar },
  { value: "watched", label: "Last watched", icon: CalendarCheck },
  { value: "aired", label: "Recently aired", icon: RadioTower },
];

type MovieFilter = (typeof MOVIE_FILTERS)[number]["value"];
type TVFilter = (typeof TV_FILTERS)[number]["value"];

type SortChoice = { sortKey: SortKey; sortDir: "asc" | "desc" };

/** "Last watched" is offered on the movies Watched pill and the TV Watching and Watched pills only. */
function hasLastWatched(kind: "movie" | "tv", filter: string): boolean {
  return (
    (kind === "movie" && filter === "watched") ||
    (kind === "tv" && (filter === "watching" || filter === "completed"))
  );
}

/** Sort used for a pill that has no remembered choice. */
function defaultSortFor(kind: "movie" | "tv", filter: string): SortChoice {
  if (kind === "tv") {
    return filter === "watching" || filter === "completed"
      ? { sortKey: "watched", sortDir: "desc" } // most recently watched show first
      : { sortKey: "added", sortDir: "desc" };
  }
  return { sortKey: "release", sortDir: "desc" }; // newest release first
}

// Bump to discard everyone's saved per-pill sorts once (they then show the defaults).
const SORT_PREFS_VERSION = 6;

function LibraryPage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const fetchLib = useServerFn(listLibrary);
  const fetchAvail = useServerFn(getMoviesAvailability);
  const region = useRegion();
  const [kind, setKind] = useState<"movie" | "tv">(lastView?.kind ?? "movie");
  // Which way the grid flicks in after a tap on the Movies / TV tab (Movies is on the left, TV on the right). Null
  // for any other change (first load, a saved view being restored), so those do not animate.
  const flick = useRef<"left" | "right" | null>(null);
  // Where and when a finger went down, to tell a sideways flick (next / previous pill) from a scroll or a tap.
  const swipe = useRef<{ x: number; y: number; t: number } | null>(null);
  // The grid that was showing when a tab or pill was tapped, as a plain copy of its first screenful (HTML, so it costs
  // almost nothing to put back), so it can slide out the other way while the new grid slides in.
  const gridBox = useRef<HTMLDivElement>(null);
  const [leaving, setLeaving] = useState<{ html: string; dir: "left" | "right" } | null>(null);
  // While a slide is playing only the first screenful of the new grid is drawn (cheap, so the slide stays smooth);
  // the rest is added the moment it ends. Null = draw everything.
  const [limit, setLimit] = useState<number | null>(null);
  // A fresh visit on a phone (the bottom bar's Library) first draws just one screenful (FLICK_ITEMS), so the page
  // appears the moment you tap; the rest of the first page is added once it has faded in (320ms). Coming Back draws
  // everything at once, so the page can be put back where you were.
  const [firstScreen, setFirstScreen] = useState(
    () => isFreshVisit() && window.matchMedia("(max-width: 767px)").matches,
  );
  useEffect(() => {
    if (!firstScreen) return;
    const t = setTimeout(() => setFirstScreen(false), 320);
    return () => clearTimeout(t);
  }, [firstScreen]);
  // How many posters are drawn. A big view (Watched can be over a thousand movies) is drawn a page at a time as you
  // scroll: drawing, and especially tearing down, every poster at once froze the phone for a second on a tab or pill
  // change. Tied to the view (tab + pill + sort), so a different view starts again at one page.
  // Coming Back to the Library (the same browser-history entry) draws as many as were drawn when you left, so the
  // page is long enough to be put back where you were. A fresh visit starts at one page.
  const [more, setMore] = useState<{ key: string; n: number }>(() => {
    const entry = historyEntry();
    return lastView && entry && lastView.entry === entry ? lastView.more : { key: "", n: PAGE_SIZE };
  });
  const [movieFilter, setMovieFilter] = useState<MovieFilter>((lastView?.movieFilter as MovieFilter) ?? "unwatched");
  const [tvFilter, setTvFilter] = useState<TVFilter>((lastView?.tvFilter as TVFilter) ?? "watching");

  // Each pill remembers its own sort. Key is `${kind}:${filter}` (e.g. "movie:watched", "tv:watching").
  // Only sorts the user actually picked are stored; a pill with no entry shows its default.
  const [sortMap, setSortMap] = useState<Record<string, SortChoice>>((lastView?.sortMap as Record<string, SortChoice>) ?? {});
  // Filter > "Include movies in cinemas": a movie that has opened in cinemas moves from Upcoming to Unwatched.
  const [cinemaCounts, setCinemaCounts] = useState<boolean>(lastView?.cinemaCounts ?? false);
  const [genreFilter, setGenreFilter] = useState<GenreFilter>(lastView?.genreFilter ?? NO_GENRES);
  const pickedGenres = genreFilter[kind];
  const toggleGenre = (g: string, on: boolean) =>
    setGenreFilter((f) => ({ ...f, [kind]: on ? [...f[kind].filter((x) => x !== g), g] : f[kind].filter((x) => x !== g) }));
  const clearGenres = () => setGenreFilter((f) => ({ ...f, [kind]: [] }));
  const [filtersOpen, setFiltersOpen] = useState(false);
  const showTitles = useShowTitles("library"); // Settings > Appearance
  const [prefsLoaded, setPrefsLoaded] = useState(lastView !== null);
  const currentFilter = kind === "movie" ? movieFilter : tvFilter;
  const currentPillKey = `${kind}:${currentFilter}`;
  // Filters > "Include movies in cinemas" is offered on the movies Unwatched and Upcoming pills only.
  const cinemaOption = kind === "movie" && (movieFilter === "unwatched" || movieFilter === "upcoming");
  const availableSorts = SORTS.filter(
    (s) => (s.value !== "watched" || hasLastWatched(kind, currentFilter)) && (s.value !== "aired" || kind === "tv"),
  );
  // The sort in effect: this pill's remembered choice (if it is still offered here), else its default.
  const remembered = sortMap[currentPillKey];
  const { sortKey: effectiveSortKey, sortDir } =
    remembered && availableSorts.some((s) => s.value === remembered.sortKey)
      ? remembered
      : defaultSortFor(kind, currentFilter);
  const chooseSort = (patch: Partial<SortChoice>) =>
    setSortMap((m) => ({ ...m, [currentPillKey]: { sortKey: effectiveSortKey, sortDir, ...patch } }));

  // Restore persisted preferences on mount (the first time only: after that they are already in `lastView`).
  useEffect(() => {
    if (lastView) return;
    try {
      const raw = localStorage.getItem("library:prefs");
      if (raw) {
        const p = JSON.parse(raw);
        if (p.kind === "movie" || p.kind === "tv") setKind(p.kind);
        // Only restore a pill that still exists (the "All" pills and TV "Favorites" were removed).
        if (MOVIE_FILTERS.some((f) => f.value === p.movieFilter)) setMovieFilter(p.movieFilter);
        // The TV pill was reset to Watching once at version 4; later versions only reset sorts.
        setTvFilter(p.v >= 4 && TV_FILTERS.some((f) => f.value === p.tvFilter) ? p.tvFilter : "watching");
        // Sorts saved before SORT_PREFS_VERSION included ones nobody chose, so they are dropped once.
        if (p.v === SORT_PREFS_VERSION && p.sortMap && typeof p.sortMap === "object") setSortMap(p.sortMap);
        if (p.cinemaCounts === true) setCinemaCounts(true);
        const genres = readGenreFilter(p.genreFilter);
        if (genres) setGenreFilter(genres);
      }
    } catch {}
    setPrefsLoaded(true);
  }, []);

  // Persist on change, but never before the saved values have been restored (that would overwrite them).
  useEffect(() => {
    if (!prefsLoaded) return;
    try {
      localStorage.setItem(
        "library:prefs",
        JSON.stringify({ v: SORT_PREFS_VERSION, kind, movieFilter, tvFilter, sortMap, cinemaCounts, genreFilter }),
      );
    } catch {}
  }, [prefsLoaded, kind, movieFilter, tvFilter, sortMap, cinemaCounts, genreFilter]);

  // Remember the view for a return visit while the app stays open (see `lastView`).
  // The entry is read once, when the Library appears: while the next page is loading the Library is still on screen
  // but the browser history has already moved on to that page.
  const ownEntry = useRef<string | undefined>(undefined);
  useEffect(() => {
    ownEntry.current ??= historyEntry();
    if (!prefsLoaded) return;
    lastView = { kind, movieFilter, tvFilter, sortMap, more, cinemaCounts, genreFilter, entry: ownEntry.current };
  }, [prefsLoaded, kind, movieFilter, tvFilter, sortMap, more, cinemaCounts, genreFilter]);

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/login" });
  }, [user, loading, navigate]);

  const { data, isLoading } = useQuery({
    queryKey: ["library", user?.id],
    queryFn: () => fetchLib(),
    enabled: !!user,
  });

  // For movies, fetch US availability for non-watched titles only.
  const movieIdsNeedingAvail = useMemo(() => {
    if (kind !== "movie") return [];
    const rows = (data ?? []).filter(
      (r) => r.media_type === "movie" && r.status !== "completed",
    );
    return rows.map((r) => r.tmdb_id).sort((a, b) => a - b);
  }, [data, kind]);

  const availQuery = useQuery({
    queryKey: ["movie-availability", movieIdsNeedingAvail],
    queryFn: () => fetchAvail({ data: { ids: movieIdsNeedingAvail } }),
    enabled: movieIdsNeedingAvail.length > 0,
    staleTime: 1000 * 60 * 30,
  });

  const availMap = useMemo(() => {
    const m = new Map<number, { available: boolean; digitalDate: string | null; cinemaDate: string | null }>();
    for (const a of availQuery.data ?? []) m.set(a.tmdbId, { available: a.available, digitalDate: a.digitalDate, cinemaDate: a.cinemaDate });
    return m;
  }, [availQuery.data]);

  // The pill's titles (before sorting). Kept apart from the sort so the Rotten Tomatoes scores below are asked for
  // only the titles under this pill.
  const pillRows = useMemo(() => {
    // A movie is "upcoming" when it cannot be watched at home yet AND it is new. An old movie that simply is not on
    // any US service (a 1997 film, say) is not upcoming: it stays under Unwatched. The library only stores the release
    // year, so "new" means this year or last year, or no date at all (not released yet), or a digital date still ahead.
    const thisYear = new Date().getFullYear();
    const isUpcoming = (r: { tmdb_id: number; release_date?: string | null }) => {
      const a = availMap.get(r.tmdb_id);
      if (!a || a.available) return false;
      // Filter > "Include movies in cinemas": a movie that has opened in cinemas counts as out, so it is not upcoming.
      if (cinemaCounts && a.cinemaDate && Date.parse(a.cinemaDate) <= Date.now()) return false;
      if (a.digitalDate && Date.parse(a.digitalDate) > Date.now()) return true;
      const year = parseInt(r.release_date ?? "", 10);
      return Number.isNaN(year) || year >= thisYear - 1;
    };
    let rows = (data ?? []).filter((r) => r.media_type === kind);
    if (kind === "movie") {
      switch (movieFilter) {
        case "watched":
          rows = rows.filter((r) => r.status === "completed");
          break;
        case "favorites":
          rows = rows.filter((r) => r.favorite);
          break;
        case "unwatched":
          rows = rows.filter((r) => r.status !== "completed" && !isUpcoming(r));
          break;
        case "upcoming":
          rows = rows.filter((r) => r.status !== "completed" && isUpcoming(r));
          break;
      }
    } else {
      if (tvFilter === "plan_to_watch")
        rows = rows.filter((r) => r.watchlist === true || r.status === "plan_to_watch");
      else rows = rows.filter((r) => r.status === tvFilter);
    }
    return rows;
  }, [data, kind, movieFilter, tvFilter, availMap, cinemaCounts]);

  // TMDB score and genres for this pill's titles. Asked for the whole pill (not just the titles the genre filter
  // leaves), so picking a genre needs no new lookup, and in the order the library lists them, so a new sort does not
  // either.
  const scoreItems = useMemo(
    () => pillRows.map((r) => ({ mediaType: r.media_type as "movie" | "tv", tmdbId: r.tmdb_id })),
    [pillRows],
  );
  const { getScore, getGenres, loading: infoLoading } = useTmdbInfo(scoreItems);

  // Filter > Genres: each genre found under this pill, A-Z, with how many titles have it. A picked genre that no title
  // here has is still listed (with 0), so it can be unticked.
  const genreOptions = useMemo(
    () => genreCounts(pillRows, (r) => getGenres(r.media_type, r.tmdb_id), pickedGenres),
    [pillRows, getGenres, pickedGenres],
  );

  // The pill's titles that have any of the picked genres (all of them when none is picked).
  const shownRows = useMemo(
    () => withGenres(pillRows, (r) => getGenres(r.media_type, r.tmdb_id), pickedGenres),
    [pillRows, pickedGenres, getGenres],
  );

  // Rotten Tomatoes scores for this pill's titles, asked for only while that sort is chosen.
  const rtItems = useMemo(
    () => pillRows.map((r) => ({ mediaType: r.media_type as "movie" | "tv", tmdbId: r.tmdb_id })),
    [pillRows],
  );
  const getRt = useRtScores(rtItems, effectiveSortKey === "rt");

  // When each show's latest episode aired, asked for only while Recently aired is chosen.
  const showIds = useMemo(() => (kind === "tv" ? pillRows.map((r) => r.tmdb_id) : []), [pillRows, kind]);
  const getLastAired = useLastAired(showIds, effectiveSortKey === "aired");

  const items = useMemo(() => {
    const upcomingDate = (r: { tmdb_id: number; release_date?: string | null }) => {
      const a = availMap.get(r.tmdb_id);
      const d = a?.digitalDate ?? a?.cinemaDate ?? r.release_date ?? "";
      return /^\d{4}$/.test(d) ? `${d}-12-31` : d;
    };
    const releaseKey = (r: { tmdb_id: number; media_type: string; release_date?: string | null }) =>
      (r.media_type === "movie" && availMap.get(r.tmdb_id)?.cinemaDate) || r.release_date || "";
    const sorted = [...shownRows].sort((a, b) => {
      let cmp = 0;
      switch (effectiveSortKey) {
        case "watched": {
          // Titles with no watch date go last, whichever direction is chosen.
          const ta = Date.parse(a.last_watched_at ?? a.watched_at ?? "");
          const tb = Date.parse(b.last_watched_at ?? b.watched_at ?? "");
          if (Number.isNaN(ta) || Number.isNaN(tb)) {
            return Number.isNaN(ta) ? (Number.isNaN(tb) ? 0 : 1) : -1;
          }
          cmp = ta - tb;
          break;
        }
        case "aired": {
          // Shows with nothing aired yet (or not looked up yet) go last, whichever direction is chosen.
          const ta = getLastAired(a.tmdb_id);
          const tb = getLastAired(b.tmdb_id);
          if (ta === null || tb === null) return ta === null ? (tb === null ? 0 : 1) : -1;
          cmp = ta - tb;
          break;
        }
        case "name":
          cmp = (a.title ?? "").localeCompare(b.title ?? "");
          break;
        case "rt": {
          // Titles with no Rotten Tomatoes score (or not looked up yet) go last, whichever direction is chosen.
          const ra = getRt(a.media_type, a.tmdb_id);
          const rb = getRt(b.media_type, b.tmdb_id);
          if (ra === null || rb === null) return ra === null ? (rb === null ? 0 : 1) : -1;
          cmp = ra - rb;
          break;
        }
        case "release": {
          if (kind === "movie" && movieFilter === "upcoming") {
            // Upcoming is ordered by the date on the poster's badge. A movie with only a year goes after the dated
            // movies of that year, and one with no date at all goes last, whichever direction is chosen.
            const ka = upcomingDate(a);
            const kb = upcomingDate(b);
            if (!ka || !kb) return ka ? -1 : kb ? 1 : 0;
            cmp = ka.localeCompare(kb);
          } else {
            // The library only stores the release year. Where the cinema date is known (movies not watched yet) it is
            // used instead, so this year's movies are in true date order rather than jumbled within the year.
            cmp = releaseKey(a).localeCompare(releaseKey(b));
          }
          break;
        }
        case "added":
        default:
          cmp = new Date(a.created_at ?? 0).getTime() - new Date(b.created_at ?? 0).getTime();
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [shownRows, kind, movieFilter, availMap, effectiveSortKey, sortDir, getRt, getLastAired]);

  const activeSort = SORTS.find((s) => s.value === effectiveSortKey)!;

  // A moment after the Library settles, fetch the first posters of the other tab (Movies <-> TV), so the first time you
  // flick across they are already there instead of loading in as empty boxes.
  useEffect(() => {
    if (!data) return;
    const other = kind === "movie" ? "tv" : "movie";
    const timer = setTimeout(() => {
      for (const r of data.filter((x) => x.media_type === other && x.poster_path).slice(0, 30)) {
        new Image().src = img(r.poster_path, "w342")!;
      }
    }, 1500);
    return () => clearTimeout(timer);
  }, [data, kind]);

  // The grid is replaced by a "Loading…" line while a movie view waits for availability; a slide would have nothing to land on.
  const gridLoading =
    isLoading ||
    (kind === "movie" && (movieFilter === "unwatched" || movieFilter === "upcoming") && availQuery.isLoading) ||
    (pickedGenres.length > 0 && infoLoading); // genres not all known yet: the filtered grid would keep growing
  const noGrid = gridLoading || items.length === 0; // "Loading…" or "Nothing here yet" instead of a grid
  useEffect(() => {
    if (noGrid) {
      setLeaving(null);
      setLimit(null);
      flick.current = null;
    }
  }, [noGrid]);

  if (loading || !user) return null;

  // The poster grid for a list of items. The first `eagerCount` posters load straight away (while a slide is playing, so
  // the sliding-in grid is never a row of empty boxes).
  const showDates = kind === "movie" && movieFilter === "upcoming";
  const renderGrid = (list: typeof items, eagerCount: number) => (
          <div className={`grid grid-cols-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-x-3 md:gap-x-4 ${showTitles ? "gap-y-5 md:gap-y-6" : "gap-y-3 md:gap-y-4"}`}>
            {list.map((it, idx) => (
              <PosterTile
                key={it.id}
                it={it}
                showTitles={showTitles}
                score={getScore(it.media_type, it.tmdb_id)}
                releaseDate={showDates ? (availMap.get(it.tmdb_id)?.digitalDate ?? availMap.get(it.tmdb_id)?.cinemaDate ?? null) : null}
                releaseKind={showDates && availMap.get(it.tmdb_id)?.digitalDate ? "digital" : "cinema"}
                eager={idx < eagerCount}
              />
            ))}
          </div>
  );
  const FLICK_ITEMS = 15; // five rows: a bit more than one phone screen
  const flicking = flick.current !== null;
  const viewKey = `${kind}|${currentFilter}|${effectiveSortKey}|${sortDir}|${pickedGenres.join(",")}`;
  const shownCount = more.key === viewKey ? more.n : PAGE_SIZE;
  const gridEl = renderGrid(
    flicking && limit !== null
      ? items.slice(0, limit)
      : items.slice(0, firstScreen ? Math.min(shownCount, FLICK_ITEMS) : shownCount),
    flicking ? FLICK_ITEMS : 0,
  );

  // Start a slide: scroll to the top (the grid being left is drawn from its top), remember the grid on screen, and
  // let the new view come in. `dir` is the side the new view is on (Movies is left of TV; pills go left to right).
  const flickTo = (dir: "left" | "right", change: () => void) => {
    const snap = snapshotOf(gridBox.current?.firstElementChild ?? null, FLICK_ITEMS, dir);
    if (!snap) return change(); // no grid on screen to slide out (a message is showing): just switch
    flick.current = dir;
    document.querySelector<HTMLElement>(APP_SCROLL_SELECTOR)?.scrollTo({ top: 0, behavior: "instant" });
    window.scrollTo({ top: 0, behavior: "instant" });
    setLeaving(snap);
    setLimit(FLICK_ITEMS);
    change();
  };

  // Go to another pill of the current tab; the grid slides the way the pill lies.
  const pills: readonly { value: string; label: string }[] = kind === "movie" ? MOVIE_FILTERS : TV_FILTERS;
  const pillIndex = pills.findIndex((f) => f.value === currentFilter);
  const goToPill = (to: number) => {
    const target = pills[to];
    if (!target || to === pillIndex) return;
    flickTo(to > pillIndex ? "right" : "left", () =>
      kind === "movie" ? setMovieFilter(target.value as MovieFilter) : setTvFilter(target.value as TVFilter),
    );
  };

  // A quick sideways flick anywhere on the page moves one pill along: flick left for the next pill, right for the
  // previous one (it stops at the first and last pill). It must be clearly sideways, so scrolling never triggers it.
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    swipe.current = e.touches.length === 1 ? { x: t.clientX, y: t.clientY, t: Date.now() } : null;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const start = swipe.current;
    swipe.current = null;
    if (!start || flick.current !== null) return; // not a one-finger touch, or a slide is still playing
    const t = e.changedTouches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 2 || Date.now() - start.t > 600) return;
    goToPill(pillIndex + (dx < 0 ? 1 : -1));
  };

  return (
    <>
    {/* No visible title (the menu already says where you are); kept for screen readers. */}
    <h1 className="sr-only">Library</h1>
    <div
      // pan-y: sideways finger movement is left to the flick above rather than to the browser.
      className="px-4 md:px-10 pt-2 pb-6 md:pt-8 md:pb-10 space-y-6 [touch-action:pan-y_pinch-zoom]"
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      onTouchCancel={() => { swipe.current = null; }}
    >
      <StickyControls>
      <div className="flex items-center justify-between gap-3">
      <div className="inline-flex bg-surface border border-border rounded-full p-1">
        {([
          { v: "movie", label: "Movies", icon: Film },
          { v: "tv", label: "TV", icon: TvIcon },
        ] as const).map((k) => (
          <button
            key={k.v}
            onClick={() => {
              if (k.v === kind) return;
              flickTo(k.v === "tv" ? "right" : "left", () => setKind(k.v));
            }}
            className={[
              "inline-flex items-center gap-2 px-5 py-2.5 text-base font-medium rounded-full transition",
              kind === k.v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
            ].join(" ")}
          >
            <k.icon className="size-5" />
            {k.label}
          </button>
        ))}
      </div>
      {/* Phone only: Calendar, which is not in the phone's bottom menu. (On a desktop it is in the sidebar.) */}
      <Link
        to="/calendar"
        aria-label="Calendar"
        className="md:hidden grid size-[3.375rem] shrink-0 place-items-center rounded-full bg-surface border border-border text-foreground transition active:scale-95"
      >
        <Calendar className="size-5" />
      </Link>
      </div>

      {/* gap-y-3: on a phone Filter and Sort wrap under the pills; same 12px as between Movies/TV and the pills. */}
      <div className="flex flex-wrap gap-x-2 gap-y-3 items-center">
        <div className="inline-flex flex-wrap bg-surface border border-border rounded-full p-1 w-full md:w-auto">
          {pills.map((t, i) => {
            const active = i === pillIndex;
            return (
              <button
                key={t.value}
                onClick={() => goToPill(i)}
                className={[
                  // On a phone the pills share the whole row evenly (flex-1), so there is no gap at the end, and are a
                  // touch tighter so all five TV pills fit on one line.
                  "px-4 py-2.5 text-sm font-medium rounded-full whitespace-nowrap max-md:flex-1 max-md:px-1 max-md:text-[13px]",
                  active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                ].join(" ")}
              >
                {t.label}
              </button>
            );
          })}
        </div>
        <span className="text-xs text-muted-foreground">{items.length} items</span>
        <div className="ml-auto flex items-center gap-2">
          <FilterButton onClick={() => setFiltersOpen(true)} pickedGenres={pickedGenres} region={region} />
          <FiltersSheet
            open={filtersOpen}
            onOpenChange={setFiltersOpen}
            toggle={
              cinemaOption
                ? {
                    label: "Include movies in cinemas",
                    hint: "Moves them to Unwatched from Upcoming",
                    checked: cinemaCounts,
                    onChange: setCinemaCounts,
                  }
                : null
            }
            genres={genreOptions}
            pickedGenres={pickedGenres}
            onToggleGenre={toggleGenre}
            genresLoading={infoLoading}
            region={region}
            onClearAll={() => {
              clearGenres();
              if (cinemaOption) setCinemaCounts(false);
            }}
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="inline-flex items-center gap-2 rounded-full bg-surface border border-border px-3 py-1.5 text-xs hover:border-primary/50">
                <activeSort.icon className="size-3.5" />
                {activeSort.label}
                {sortDir === "asc" ? <ArrowUp className="size-3.5" /> : <ArrowDown className="size-3.5" />}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {availableSorts.map((s) => (
                <DropdownMenuItem
                  key={s.value}
                  onClick={() => chooseSort({ sortKey: s.value })}
                  className={effectiveSortKey === s.value ? "bg-primary/15 text-primary" : ""}
                >
                  <s.icon className="size-4" />
                  {s.label}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => chooseSort({ sortDir: sortDir === "asc" ? "desc" : "asc" })}>
                {sortDir === "asc" ? <ArrowUp className="size-4" /> : <ArrowDown className="size-4" />}
                {sortDir === "asc" ? "Ascending" : "Descending"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      </StickyControls>

      {gridLoading ? (
        <p className="text-muted-foreground text-sm">Loading…</p>
      ) : items.length === 0 && pickedGenres.length > 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <p>Nothing here in {pickedGenresLabel(pickedGenres)}.</p>
          <button type="button" onClick={clearGenres} className="text-primary hover:underline text-sm">
            Show all genres
          </button>
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <p>Nothing here yet.</p>
          <Link to="/search" className="text-primary hover:underline text-sm">Find something to watch →</Link>
        </div>
      ) : (
        <div className="relative overflow-x-clip">
          {/* The grid you just left slides out while the new one slides in (no empty moment between them). */}
          {leaving && (
            <div
              aria-hidden
              inert
              className={`pointer-events-none absolute inset-x-0 top-0 ${leaving.dir === "right" ? "cx-slide-out-left" : "cx-slide-out-right"}`}
              onAnimationEnd={(ev) => { if (ev.target === ev.currentTarget) setLeaving(null); }}
              dangerouslySetInnerHTML={{ __html: leaving.html }}
            >
            </div>
          )}
          <div
            ref={gridBox}
            key={`${kind}|${currentFilter}`}
            className={flick.current === "right" ? "cx-slide-in-right" : flick.current === "left" ? "cx-slide-in-left" : ""}
            onAnimationEnd={(ev) => {
              if (ev.target !== ev.currentTarget) return;
              flick.current = null;
              setLimit(null); // now draw the rest of the grid
            }}
          >
            {gridEl}
            {/* The next page of posters is drawn when you scroll near the end of what is drawn. Not during a slide. */}
            {!flicking && !firstScreen && shownCount < items.length && (
              <LoadMore key={shownCount} onMore={() => setMore({ key: viewKey, n: shownCount + PAGE_SIZE })} />
            )}
          </div>
        </div>
      )}
    </div>
    </>
  );
}