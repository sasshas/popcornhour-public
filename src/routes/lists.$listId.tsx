import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Calendar,
  CalendarCheck,
  CheckSquare,
  Download,
  EllipsisVertical,
  MonitorPlay,
  Pencil,
  Star,
  Trash2,
  Type,
  X,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/hooks/use-auth";
import { useRegion } from "@/hooks/use-region";
import { FilterButton, FiltersSheet, genreCounts, pickedGenresLabel, withGenres } from "@/components/media/FiltersSheet";
import { listLibrary } from "@/lib/library.functions";
import { getMoviesAvailability } from "@/lib/tmdb.functions";
import { getList, updateList, deleteList, removeManyFromList } from "@/lib/lists.functions";
import { ImportListSheet } from "@/components/media/ImportListSheet";
import { img } from "@/lib/tmdb";
import { markHeroPoster, rememberPeek } from "@/lib/peek";
import { PosterBadges } from "@/components/media/PosterBadges";
import { useTmdbInfo } from "@/hooks/use-tmdb-scores";
import { useShowTitles } from "@/hooks/use-show-titles";
import { useRtScores } from "@/hooks/use-rt-scores";
import { StickyControls } from "@/components/layout/StickyControls";
import { LoadMore } from "@/components/media/LoadMore";
import { ReleaseDateBadge, type ReleaseKind } from "@/components/media/ReleaseDateBadge";
import {
  airDates,
  compareUpcoming,
  isUpcomingMovie,
  upcomingBadge,
  upcomingDates,
  upcomingDateSort,
  firstPillDateSort,
  type Availability,
  type UpcomingDates,
} from "@/lib/upcoming";

export const Route = createFileRoute("/lists/$listId")({
  head: () => ({ meta: [{ title: "List — Popcornhour" }] }),
  component: ListDetailPage,
});

type ReleaseFilter = "released" | "unreleased" | "all";
const RELEASE_FILTERS: { value: ReleaseFilter; label: string }[] = [
  { value: "released", label: "Released" },
  { value: "unreleased", label: "Upcoming" }, // the value keeps its old name, so pills remembered on a device still work
  { value: "all", label: "All" },
];

// The Library's Sort menu, same options and icons. Last watched comes from your library, so something in the list
// that is not in your library goes last for it; Rotten Tomatoes is the % on the posters, and titles without one go last.
// On Upcoming, Streaming date and the cinema sort (shown as "Release date") take the place of the usual Release date (as on the Library's Upcoming).
type SortKey = "added" | "name" | "rt" | "release" | "streaming" | "cinema" | "watched";
type SortChoice = { sortKey: SortKey; sortDir: "asc" | "desc" };
const SORTS: { value: SortKey; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { value: "added", label: "Date added", icon: Calendar },
  { value: "name", label: "Name", icon: Type },
  { value: "rt", label: "Rotten Tomatoes", icon: Star },
  { value: "release", label: "Release date", icon: Calendar },
  { value: "streaming", label: "Streaming date", icon: MonitorPlay },
  { value: "cinema", label: "Release date", icon: Calendar }, // labelled Release date: straight-to-streaming movies are in it too
  { value: "watched", label: "Last watched", icon: CalendarCheck },
];
/**
 * The sorts offered on a pill. Each pill offers one date sort. All: Release date. Released and Upcoming: the one
 * Filters > "Released means" (Anywhere = on) picks (src/lib/upcoming.ts), as on the Library: off, both go by Streaming date;
 * on, Released goes by Release date and Upcoming by the cinema sort (also shown as "Release date").
 */
const DATE_SORTS: SortKey[] = ["release", "streaming", "cinema"];
const dateSortFor = (f: ReleaseFilter, cinemaCounts: boolean): SortKey =>
  f === "all" ? "release" : f === "unreleased" ? upcomingDateSort(cinemaCounts) : firstPillDateSort(cinemaCounts);
const sortsFor = (f: ReleaseFilter, cinemaCounts: boolean) =>
  SORTS.filter((s) => !DATE_SORTS.includes(s.value) || s.value === dateSortFor(f, cinemaCounts));
// Each pill has its own sort; by default its date sort: Released and All newest first, Upcoming soonest first.
const defaultSort = (f: ReleaseFilter, cinemaCounts: boolean): SortChoice => ({
  sortKey: dateSortFor(f, cinemaCounts),
  sortDir: f === "unreleased" ? "asc" : "desc",
});
const DEFAULT_SORTS: Record<ReleaseFilter, SortChoice> = {
  released: defaultSort("released", false),
  unreleased: defaultSort("unreleased", false),
  all: defaultSort("all", false),
};
// The sort chosen on each pill is remembered on this device, the same for every list.
// "-2": Streaming date became the Released default, so a sort saved for Released under the old key is dropped once.
const SORT_KEY = "cx:list-sorts-2";
const OLD_SORT_KEY = "cx:list-sorts";
const isSortChoice = (p: unknown): p is SortChoice =>
  !!p &&
  SORTS.some((s) => s.value === (p as SortChoice).sortKey) &&
  ((p as SortChoice).sortDir === "asc" || (p as SortChoice).sortDir === "desc");
function readSorts(): Record<ReleaseFilter, SortChoice> {
  const out = { ...DEFAULT_SORTS };
  try {
    let p = JSON.parse(localStorage.getItem(SORT_KEY) ?? "null");
    if (!p) {
      p = JSON.parse(localStorage.getItem(OLD_SORT_KEY) ?? "null");
      if (p) delete p.released; // see SORT_KEY
    }
    // Whether a saved sort is offered is checked where it is used (it depends on the cinemas filter); a date sort
    // that is not offered there falls back to the pill's default.
    for (const f of RELEASE_FILTERS) {
      const c = p?.[f.value];
      if (isSortChoice(c)) out[f.value] = c;
    }
  } catch {
    /* nothing saved, or no storage */
  }
  return out;
}

// Filters > "Released means" (Anywhere = on) (Released and Upcoming pills), remembered on this device for every list.
// It also picks the date sort and poster pills of those two pills (see sortsFor). (It replaced "Streaming only",
// whose saved choice is not carried over.)
const CINEMA_KEY = "cx:list-cinema-counts";

// Filters > Genres: the genres picked on each list, remembered on this device ({ [list id]: ["Comedy", ...] }). Kept
// per list, since each list holds different things. A title shows when it has any of them.
const GENRES_KEY = "cx:list-genres";
function readListGenres(listId: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(GENRES_KEY) ?? "null")?.[listId];
    return Array.isArray(v) ? v.filter((g): g is string => typeof g === "string") : [];
  } catch {
    return []; // nothing saved, or no storage
  }
}
function storeListGenres(listId: string, genres: string[]) {
  try {
    const all = JSON.parse(localStorage.getItem(GENRES_KEY) ?? "null") ?? {};
    if (genres.length) all[listId] = genres;
    else delete all[listId];
    localStorage.setItem(GENRES_KEY, JSON.stringify(all));
  } catch {
    /* not saved; still applies now */
  }
}

/** Posters drawn at a time (as in the Library): about ten rows on a phone. The next lot is drawn as you near the end. */
const PAGE_SIZE = 30;

type ListItem = NonNullable<Awaited<ReturnType<typeof getList>>>["items"][number];

/** Joins the availability answers. A fixed function passed as `combine`, so the result only changes when an answer does. */
function joinAvailability(results: { data?: ({ tmdbId: number } & Availability)[]; isPending: boolean }[]) {
  const byId = new Map<number, Availability>();
  for (const r of results) for (const a of r.data ?? []) byId.set(a.tmdbId, a);
  return { byId, pending: results.some((r) => r.isPending) };
}

/**
 * What a list was last showing, kept while the app stays open in this browser tab (as the Library's `lastView`).
 * Opening a movie removes the list from the page; without this, coming Back started it again on Released.
 * Only ever written in the browser (inside an effect).
 */
let lastView: {
  listId: string;
  /** The browser-history entry the list was on. Back returns to the same entry; a fresh visit is a new one. */
  entry: string | undefined;
  releaseFilter: ReleaseFilter;
  sorts: Record<ReleaseFilter, SortChoice>;
  cinemaCounts: boolean;
  /** The genres picked on this list (Filters > Genres). */
  genres: string[];
  /** How many posters were drawn, and for which view (pill, sort, filters), so Back can scroll to where you were. */
  more: { key: string; n: number };
} | null = null;

/** The router's id for the browser-history entry now showing. */
function historyEntry(): string | undefined {
  return typeof window === "undefined" ? undefined : (window.history.state?.__TSR_key as string | undefined);
}

/** Today's date on this device as YYYY-MM-DD (local time, not UTC, so it matches the day you see). */
function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * One poster in a list. Memoised (as the Library's `PosterTile`): it is drawn again only when something about this
 * poster changes, not every time the page around it does (typing a new name, a menu opening, the next lot loading,
 * another poster being ticked). `onToggle` must be a stable function.
 *
 * In Select mode (⋮ > Select) every poster shows a cross in its top-right corner and a tap picks it (or un-picks it)
 * instead of opening it; picked posters turn red. Outside Select mode there is no cross: it used to appear on hover,
 * and on a phone (no hover) it was invisible but could still be tapped, removing a title by accident.
 */
const ListTile = memo(function ListTile({
  it,
  showTitles,
  score,
  badgeDate,
  badgeKind,
  selecting,
  selected,
  onToggle,
}: {
  it: ListItem;
  showTitles: boolean;
  score: number | null;
  /** The date pill (Upcoming only, as the Library's): a movie's digital date, else its cinema date; a show's first air date. */
  badgeDate: string | null;
  badgeKind: ReleaseKind;
  selecting: boolean;
  selected: boolean;
  onToggle: (id: string) => void;
}) {
  return (
    <Link
      to={it.media_type === "tv" ? "/tv/$id" : "/movie/$id"}
      params={{ id: String(it.tmdb_id) }}
      className="group block select-none"
      onClick={(e) => {
        if (selecting) {
          e.preventDefault();
          onToggle(it.id);
          return;
        }
        // Same as the Library: the page being opened shows this poster and title at once, and the
        // poster grows into the big one there (Back shrinks it into this card again).
        rememberPeek(it.media_type, it.tmdb_id, { title: it.title, posterPath: it.poster_path ?? null, backdropPath: it.backdrop_path });
        markHeroPoster(e.currentTarget);
      }}
      role={selecting ? "checkbox" : undefined}
      aria-checked={selecting ? selected : undefined}
      title={showTitles && !selecting ? undefined : it.title} // tooltip + accessible name when the caption is hidden
      aria-label={showTitles && !selecting ? undefined : it.title}
    >
      <div className="relative">
        <div
          data-hero={`${it.media_type}:${it.tmdb_id}`}
          className={`aspect-[2/3] rounded-xl overflow-hidden bg-surface ${selected ? "ring-2 ring-destructive" : "ring-1 ring-border"}`}
        >
          {it.poster_path ? (
            <img
              src={img(it.poster_path, "w342")!}
              alt={it.title}
              loading="lazy"
              className={`w-full h-full object-cover transition-[transform,opacity] duration-500 ${selecting ? "" : "group-hover:scale-[1.04]"} ${selected ? "opacity-50" : ""}`}
            />
          ) : (
            <div className="w-full h-full grid place-items-center text-muted-foreground text-xs">No image</div>
          )}
        </div>
        <PosterBadges
          mediaType={it.media_type}
          tmdbId={it.tmdb_id}
          score={score}
          showList={false}
          bottomLeft={badgeDate && <ReleaseDateBadge date={badgeDate} kind={badgeKind} />}
        />
        {selecting && (
          // Sits over the watched / watchlist badge while selecting. Solid, no backdrop blur: it is on every poster.
          <span
            aria-hidden
            className={[
              "absolute top-1.5 right-1.5 z-10 size-7 grid place-items-center rounded-full border shadow-md transition-colors",
              selected ? "bg-destructive border-destructive text-white" : "bg-background/90 border-border text-muted-foreground",
            ].join(" ")}
          >
            <X className="size-4" strokeWidth={selected ? 3 : 2} />
          </span>
        )}
      </div>
      {/* Title and year go together: with titles turned off (Settings > Appearance) it is just the poster. */}
      {showTitles && (
        <>
          <p className="mt-2 text-sm font-medium line-clamp-1">{it.title}</p>
          <p className="text-xs text-muted-foreground">{it.release_date?.slice(0, 4) || " "}</p>
        </>
      )}
    </Link>
  );
});

function ListDetailPage() {
  const { listId } = Route.useParams();
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const fetchList = useServerFn(getList);
  const fetchUpdate = useServerFn(updateList);
  const fetchDelete = useServerFn(deleteList);
  const fetchRemove = useServerFn(removeManyFromList);

  const [editing, setEditing] = useState(false);
  // ⋮ > Import: the panel (MDBList link or a list of titles).
  const [importOpen, setImportOpen] = useState(false);
  // ⋮ > Select: crosses show on every poster, a tap picks a poster, and the bar at the bottom removes the picked ones.
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set()); // list item ids
  const toggleSelected = useCallback((id: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);
  const stopSelecting = () => {
    setSelecting(false);
    setSelected(new Set());
  };
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  // Coming Back to this list (the same browser-history entry, e.g. from a movie) puts back the pill you were on.
  // The sorts and Streaming only come back at once too, so the posters are drawn in the same order straight away
  // and the router can return you to where you had scrolled (as in the Library).
  const returning = lastView && lastView.listId === listId && lastView.entry === historyEntry() ? lastView : null;
  const [releaseFilter, setReleaseFilter] = useState<ReleaseFilter>(returning?.releaseFilter ?? "released");
  // Filters > "Released means" (Anywhere = on) (Released and Upcoming pills), as the Library's: a movie that has opened in
  // cinemas moves from Upcoming to Released. Remembered on this device. Off unless switched on.
  const [cinemaCounts, setCinemaCountsState] = useState(lastView?.cinemaCounts ?? false);
  useEffect(() => {
    if (lastView) return; // already known (read on an earlier visit while the app has been open)
    try {
      setCinemaCountsState(localStorage.getItem(CINEMA_KEY) === "1");
    } catch {
      /* no storage */
    }
  }, []);
  const setCinemaCounts = (on: boolean) => {
    setCinemaCountsState(on);
    setSelected(new Set()); // the pills' contents change
    try {
      localStorage.setItem(CINEMA_KEY, on ? "1" : "0");
    } catch {
      /* not saved; still applies now */
    }
  };
  const [pickedGenres, setPickedGenresState] = useState<string[]>(lastView?.listId === listId ? lastView.genres : []);
  useEffect(() => {
    if (lastView?.listId === listId) return; // already known (this list was open earlier while the app has been open)
    setPickedGenresState(readListGenres(listId));
  }, [listId]);
  const setPickedGenres = (next: string[]) => {
    setPickedGenresState(next);
    setSelected(new Set()); // what was picked may no longer be showing
    storeListGenres(listId, next);
  };
  const toggleGenre = (g: string, on: boolean) =>
    setPickedGenres(on ? [...pickedGenres.filter((x) => x !== g), g] : pickedGenres.filter((x) => x !== g));
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sorts, setSorts] = useState<Record<ReleaseFilter, SortChoice>>(lastView?.sorts ?? DEFAULT_SORTS);
  // Read after mount so the server and first browser render agree (not needed once known: see `lastView`).
  useEffect(() => {
    if (!lastView) setSorts(readSorts());
  }, []);
  // Note what is showing, for a return visit. The entry is read once, when the list appears (while the next page
  // loads, this one is still on screen and the history already shows the new entry).
  // How many posters are drawn. It counts for one view only: another pill, sort or filter starts again at one page.
  const [more, setMore] = useState<{ key: string; n: number }>(returning?.more ?? { key: "", n: PAGE_SIZE });
  const ownEntry = useRef<string | undefined>(undefined);
  useEffect(() => {
    ownEntry.current ??= historyEntry();
    lastView = { listId, entry: ownEntry.current, releaseFilter, sorts, cinemaCounts, genres: pickedGenres, more };
  }, [listId, releaseFilter, sorts, cinemaCounts, pickedGenres, more]);
  // The sort of the pill that is showing (its default if what is saved is not offered there).
  const sort = sortsFor(releaseFilter, cinemaCounts).some((s) => s.value === sorts[releaseFilter].sortKey)
    ? sorts[releaseFilter]
    : defaultSort(releaseFilter, cinemaCounts);
  // Changes only the showing pill's sort.
  const chooseSort = (patch: Partial<SortChoice>) =>
    setSorts((all) => {
      const next = { ...all, [releaseFilter]: { ...sort, ...patch } };
      try {
        localStorage.setItem(SORT_KEY, JSON.stringify(next));
      } catch {
        /* not saved; still applies now */
      }
      return next;
    });
  const region = useRegion(); // Filter > Streaming country: the same setting as the Library's
  const fetchLib = useServerFn(listLibrary);

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/login" });
  }, [user, loading, navigate]);

  const { data: list, isLoading } = useQuery({
    queryKey: ["list", listId, user?.id],
    queryFn: () => fetchList({ data: { id: listId } }),
    enabled: !!user,
  });

  // Your library (the same request the Library page makes, so it is usually already loaded): gives each list item
  // when you last watched it, for the Last watched sort.
  const { data: library } = useQuery({
    queryKey: ["library", user?.id],
    queryFn: () => fetchLib(),
    enabled: !!user,
  });
  const libByKey = useMemo(() => {
    const m = new Map<string, { watched: number }>();
    for (const r of library ?? []) {
      m.set(`${r.media_type}:${r.tmdb_id}`, { watched: Date.parse(r.last_watched_at ?? r.watched_at ?? "") });
    }
    return m;
  }, [library]);

  useEffect(() => {
    if (list) {
      setName(list.name);
      setDescription(list.description ?? "");
    }
  }, [list?.id]);

  const save = useMutation({
    mutationFn: () =>
      fetchUpdate({
        data: {
          id: listId,
          name: name.trim(),
          description: description.trim() ? description.trim() : null,
        },
      }),
    onSuccess: () => {
      setEditing(false);
      qc.invalidateQueries({ queryKey: ["list", listId] });
      qc.invalidateQueries({ queryKey: ["lists"] });
    },
  });

  const remove = useMutation({
    mutationFn: () => fetchDelete({ data: { id: listId } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["lists"] });
      navigate({ to: "/lists" });
    },
  });

  const removeSelected = useMutation({
    mutationFn: (items: { mediaType: "movie" | "tv"; tmdbId: number }[]) => fetchRemove({ data: { listId, items } }),
    onSuccess: ({ removed }) => {
      stopSelecting();
      toast.success(`Removed ${removed} ${removed === 1 ? "title" : "titles"} from the list`);
      qc.invalidateQueries({ queryKey: ["list", listId] });
      qc.invalidateQueries({ queryKey: ["lists"] }); // My Lists' counts and the "in a list" badges elsewhere
    },
    onError: () => toast.error("Couldn't remove them. Nothing was changed"),
  });

  // ⋮ > Import: what is on the list already (the panel labels those), and a refresh once something was added.
  const onListKeys = useMemo(
    () => new Set((list?.items ?? []).map((i) => `${i.media_type}:${i.tmdb_id}`)),
    [list?.items],
  );
  const afterImport = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["list", listId] });
    qc.invalidateQueries({ queryKey: ["lists"] }); // My Lists' counts and the "in a list" badges elsewhere
  }, [qc, listId]);

  // Hooks must run on every render, so this sits above the early returns below. Calling it after
  // them changed the hook count between the loading and loaded renders (React error #310).
  const scoreItems = useMemo(
    () => (list?.items ?? []).map((i) => ({ mediaType: i.media_type as "movie" | "tv", tmdbId: i.tmdb_id })),
    [list?.items],
  );
  // getDate: the full release date from TMDB. Lists imported from Trakt only saved the year ("2026"), which cannot
  // tell August from November or say whether a film later this year is out yet.
  // datesLoading: until they arrive the posters and count wait (otherwise films due later this year would show
  // under Released for a moment and then jump to Upcoming).
  const { getScore, getDate, getGenres, loading: datesLoading } = useTmdbInfo(scoreItems);
  // Rotten Tomatoes scores for every title in the list, asked for only while that sort is chosen.
  const getRt = useRtScores(scoreItems, sort.sortKey === "rt");
  const showTitles = useShowTitles("lists"); // Settings > Appearance

  // Upcoming works as the Library's (the same rule, src/lib/upcoming.ts): a movie is Upcoming while it cannot be
  // watched at home yet and is new; a show while its first air date is still ahead. Availability is asked for only
  // the movies that could be upcoming (this year's, last year's and undated ones; older movies are always Released),
  // once their full dates are in, and only while Released or Upcoming is showing.
  const thisYear = new Date().getFullYear();
  const newMovieIds = useMemo(() => {
    if (releaseFilter === "all" || datesLoading) return [];
    const ids = new Set<number>();
    for (const it of list?.items ?? []) {
      if (it.media_type !== "movie") continue;
      const year = parseInt((getDate("movie", it.tmdb_id) ?? it.release_date ?? "").slice(0, 4), 10);
      if (Number.isNaN(year) || year >= thisYear - 1) ids.add(it.tmdb_id);
    }
    return [...ids].sort((a, b) => a - b);
  }, [releaseFilter, datesLoading, list?.items, getDate, thisYear]);
  const fetchAvail = useServerFn(getMoviesAvailability);
  const avail = useQueries({
    queries: Array.from({ length: Math.ceil(newMovieIds.length / 500) }, (_, i) => newMovieIds.slice(i * 500, i * 500 + 500)).map(
      (ids) => ({
        // The same request (and key) the Library makes, so answers are shared.
        queryKey: ["movie-availability", ids],
        queryFn: () => fetchAvail({ data: { ids } }),
        staleTime: 1000 * 60 * 30,
      }),
    ),
    combine: joinAvailability,
  });
  const availById = avail.byId;
  // The posters and the count wait for the full dates and what is streaming, so nothing shows under the wrong pill
  // and then jumps.
  const gridWaiting = datesLoading || avail.pending;

  // The posters under the showing pill, in the chosen order. Worked out only when one of those things changes, not on
  // every redraw of the page (typing a new name, a menu opening, the next lot of posters being drawn).
  const { sortKey, sortDir } = sort;
  // The best date known for an item: TMDB's full date, else what the list saved (often just the year).
  const dateOf = useCallback(
    (it: ListItem) => getDate(it.media_type, it.tmdb_id) ?? (it.release_date || null),
    [getDate],
  );
  // The items under the showing pill (before the genre filter, which counts its genres from these).
  const pillItems = useMemo(() => {
    const today = todayLocal();
    return (list?.items ?? []).filter((it) => {
      if (releaseFilter === "all") return true;
      let upcoming: boolean;
      if (it.media_type === "movie") {
        // Older movies were not looked up (no availability), so they are never upcoming, as in the Library.
        upcoming = isUpcomingMovie(availById.get(it.tmdb_id), dateOf(it), cinemaCounts);
      } else {
        // A show: upcoming until its first air date. A year alone counts as aired once that year has started.
        const d = dateOf(it);
        upcoming = !d || (d.length === 4 ? d > today.slice(0, 4) : d.slice(0, 10) > today);
      }
      return releaseFilter === "unreleased" ? upcoming : !upcoming;
    });
  }, [list?.items, releaseFilter, availById, cinemaCounts, dateOf]);
  // Upcoming's dates (as the Library's, src/lib/upcoming.ts): a movie's streaming and cinema dates, a show's first air
  // date for both. The poster's pill shows the cinema date when sorted by Cinema date, else the streaming date when
  // there is one (else the cinema date); a show's pill is its first air date.
  const upcomingDatesOf = useCallback(
    (it: ListItem): UpcomingDates =>
      it.media_type === "movie" ? upcomingDates(availById.get(it.tmdb_id), dateOf(it)) : airDates(dateOf(it)),
    [availById, dateOf],
  );
  const badgeOf = (it: ListItem): { date: string; kind: ReleaseKind } | null => {
    if (it.media_type === "movie") return upcomingBadge(availById.get(it.tmdb_id), upcomingDateSort(cinemaCounts));
    const d = dateOf(it);
    return d && d.length >= 10 ? { date: d.slice(0, 10), kind: "tv" } : null;
  };
  const genreOptions = useMemo(
    () => genreCounts(pillItems, (it) => getGenres(it.media_type, it.tmdb_id), pickedGenres),
    [pillItems, getGenres, pickedGenres],
  );
  const shownItems = useMemo(() => {
    const filtered = [...withGenres(pillItems, (it) => getGenres(it.media_type, it.tmdb_id), pickedGenres)];
    const dir = sortDir === "asc" ? 1 : -1;
    // Items with nothing to sort by (no date, no Rotten Tomatoes score, never watched) go last, whichever direction is chosen.
    const byMaybe = <T,>(a: T | null, b: T | null, cmp: (x: T, y: T) => number) =>
      a === null || b === null ? (a === null ? (b === null ? 0 : 1) : -1) : dir * cmp(a, b);
    const watchedOf = (it: ListItem) => {
      const w = libByKey.get(`${it.media_type}:${it.tmdb_id}`)?.watched;
      return w === undefined || Number.isNaN(w) ? null : w;
    };
    return filtered.sort((a, b) => {
      switch (sortKey) {
        case "name":
          return dir * (a.title ?? "").localeCompare(b.title ?? "");
        case "rt":
          return byMaybe(getRt(a.media_type, a.tmdb_id), getRt(b.media_type, b.tmdb_id), (x, y) => x - y);
        case "release":
          // On Released (cinemas filter on) the US cinema date where it is known, as the Library's Unwatched; on All
          // (nothing looked up there) TMDB's release date.
          return releaseFilter === "released"
            ? compareUpcoming(upcomingDatesOf(a), upcomingDatesOf(b), "cinema", dir)
            : byMaybe(dateOf(a), dateOf(b), (x, y) => x.localeCompare(y));
        case "streaming":
        case "cinema":
          // When it can be watched at home, or when it opens in cinemas (as the Library's, src/lib/upcoming.ts).
          return compareUpcoming(upcomingDatesOf(a), upcomingDatesOf(b), sortKey, dir);
        case "watched":
          return byMaybe(watchedOf(a), watchedOf(b), (x, y) => x - y);
        case "added":
        default:
          return dir * (Date.parse(a.added_at ?? "") - Date.parse(b.added_at ?? "") || 0);
      }
    });
  }, [pillItems, pickedGenres, getGenres, dateOf, sortKey, sortDir, getRt, libByKey, upcomingDatesOf, releaseFilter]);
  // Only the first `shownCount` are drawn; the rest follow as you scroll near the end.
  const viewKey = `${releaseFilter}|${sortKey}|${sortDir}|${cinemaCounts}|${pickedGenres.join(",")}`;
  const shownCount = more.key === viewKey ? more.n : PAGE_SIZE;

  // Still checking who is signed in (the list is not fetched until then), or fetching it: show Loading,
  // not "List not found" (which used to flash for a moment on every open).
  if (loading || !user || isLoading) {
    return <div className="p-10 text-muted-foreground">Loading…</div>;
  }
  if (!list) {
    return <div className="p-10">List not found.</div>;
  }

  const activeSort = SORTS.find((s) => s.value === sortKey)!;

  return (
    <>
      {/* While selecting, extra room at the bottom so the bar never covers the last row of posters. */}
      <div className={`px-4 md:px-10 pt-2 md:pt-8 max-w-6xl ${selecting ? "pb-28" : "pb-8"}`}>
        {/* The whole top toolbar (Back, name, ⋮, item count, pills, Filter, Sort). On a phone it sticks to the top
            while you scroll, like the Library's: it slides away scrolling down and comes back, as glass, the moment
            you scroll up. */}
        <StickyControls className="mb-3 md:mb-6">
        {editing ? (
          <div className="space-y-3 mb-4">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              className="w-full text-2xl font-bold bg-background border border-border rounded-lg px-3 py-2 outline-none focus:border-primary"
            />
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Description (optional)"
              maxLength={2000}
              rows={2}
              className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm outline-none focus:border-primary resize-none"
            />
            <div className="flex gap-2">
              <button onClick={() => save.mutate()} disabled={!name.trim() || save.isPending} className="rounded-full bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground disabled:opacity-50">Save</button>
              <button onClick={() => { setEditing(false); setName(list.name); setDescription(list.description ?? ""); }} className="rounded-full px-4 py-1.5 text-sm text-muted-foreground hover:text-foreground">Cancel</button>
            </div>
          </div>
        ) : (
          <div className={(list.items?.length ?? 0) > 0 ? "mb-5" : ""}>
            {/* One row: round Back button (to all lists), the list's name, and the ⋮ menu (Edit list / Delete list).
                A long name wraps onto a second line (then ends in "…"); the two buttons stay level with its first line. */}
            <div className="flex items-start gap-3">
              <Link
                to="/lists"
                aria-label="All lists"
                title="All lists"
                className="size-9 shrink-0 grid place-items-center rounded-full bg-surface border border-border hover:border-primary/50"
              >
                <ArrowLeft className="size-4" />
              </Link>
              <h1 className="flex-1 min-w-0 text-2xl md:text-3xl leading-9 font-bold tracking-tight line-clamp-2 break-words">
                {list.name}
              </h1>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    aria-label="List options"
                    title="List options"
                    className="size-9 shrink-0 grid place-items-center rounded-full bg-surface border border-border hover:border-primary/50"
                  >
                    <EllipsisVertical className="size-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[10rem]">
                  {(list.items?.length ?? 0) > 0 && (
                    <DropdownMenuItem onSelect={() => (selecting ? stopSelecting() : setSelecting(true))}>
                      <CheckSquare className="size-4" /> {selecting ? "Stop selecting" : "Select"}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onSelect={() => setEditing(true)}>
                    <Pencil className="size-4" /> Edit list
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setImportOpen(true)}>
                    <Download className="size-4" /> Import
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    // Wait for the menu to close before the "are you sure?" box opens.
                    onSelect={() =>
                      setTimeout(() => {
                        if (confirm(`Delete "${list.name}"? This can't be undone.`)) remove.mutate();
                      }, 0)
                    }
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 className="size-4" /> Delete list
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            {/* Item count and description on one line, e.g. "547 items · NSFJ" (a long description wraps). */}
            <p className="mt-1 text-sm text-muted-foreground">
              {(list.items?.length ?? 0)} {(list.items?.length ?? 0) === 1 ? "item" : "items"}
              {list.description && <> · <span className="text-foreground/80">{list.description}</span></>}
            </p>
          </div>
        )}

        {/* Released / Upcoming / All. Released = has a release date of today or earlier. */}
        {/* Filter and Sort sit to the right of the pills, as in the Library (on a phone they wrap underneath). */}
        {(list.items?.length ?? 0) > 0 && (
          <div className="flex flex-wrap gap-x-2 gap-y-2 items-center">
          <div className="inline-flex bg-surface border border-border rounded-full p-1" role="group" aria-label="Show">
            {RELEASE_FILTERS.map((f) => (
              <button
                key={f.value}
                onClick={() => {
                  setReleaseFilter(f.value);
                  setSelected(new Set()); // what was picked is no longer showing
                }}
                aria-pressed={releaseFilter === f.value}
                className={[
                  "px-4 py-2 text-sm font-medium rounded-full whitespace-nowrap",
                  releaseFilter === f.value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                ].join(" ")}
              >
                {f.label}
              </button>
            ))}
          </div>
          {/* The Filter / Sort line, with how many are showing under this pill and filter on its left. On a phone
              it is a whole line of its own under the pills; on a wider screen it carries on after them. */}
          <div className="flex flex-1 items-center gap-2 max-md:basis-full">
          <span className="text-xs text-muted-foreground">
            {gridWaiting ? " " : `${shownItems.length} ${shownItems.length === 1 ? "item" : "items"}`}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <FilterButton onClick={() => setFiltersOpen(true)} pickedGenres={pickedGenres} region={region} />
            <FiltersSheet
              open={filtersOpen}
              onOpenChange={setFiltersOpen}
              releasedMeans={releaseFilter !== "all" ? { anywhere: cinemaCounts, onChange: setCinemaCounts } : null}
              genres={genreOptions}
              pickedGenres={pickedGenres}
              onToggleGenre={toggleGenre}
              genresLoading={datesLoading}
              region={region}
              onClearAll={() => {
                setPickedGenres([]);
                if (releaseFilter !== "all" && cinemaCounts) setCinemaCounts(false);
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
                {sortsFor(releaseFilter, cinemaCounts).map((s) => (
                  <DropdownMenuItem
                    key={s.value}
                    onClick={() => chooseSort({ sortKey: s.value })}
                    className={sortKey === s.value ? "bg-primary/15 text-primary" : ""}
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
          </div>
        )}
        </StickyControls>

        {/* Items grid */}
        {(list.items?.length ?? 0) === 0 ? (
          <div className="rounded-2xl border border-dashed border-border p-12 text-center">
            <p className="text-muted-foreground">This list is empty.</p>
            <button
              onClick={() => setImportOpen(true)}
              className="mt-4 inline-flex items-center gap-2 rounded-full bg-surface border border-border px-4 py-2 text-sm font-medium hover:border-primary/50"
            >
              <Download className="size-4" /> Import
            </button>
          </div>
        ) : gridWaiting ? (
          <p className="py-10 text-center text-sm text-muted-foreground">Loading…</p>
        ) : shownItems.length === 0 && pickedGenres.length > 0 ? (
          <div className="rounded-2xl border border-dashed border-border p-12 text-center">
            <p className="text-muted-foreground">Nothing here in {pickedGenresLabel(pickedGenres)}.</p>
            <button type="button" onClick={() => setPickedGenres([])} className="text-primary hover:underline text-sm">
              Show all genres
            </button>
          </div>
        ) : shownItems.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border p-12 text-center">
            <p className="text-muted-foreground">
              {releaseFilter === "released" ? "Nothing in this list is out yet." : "Everything in this list is already out."}
            </p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3 md:gap-4">
              {shownItems.slice(0, shownCount).map((it) => {
                const badge = releaseFilter === "unreleased" ? badgeOf(it) : null;
                return (
                <ListTile
                  key={it.id}
                  it={it}
                  showTitles={showTitles}
                  score={getScore(it.media_type, it.tmdb_id)}
                  badgeDate={badge?.date ?? null}
                  badgeKind={badge?.kind ?? "cinema"}
                  selecting={selecting}
                  selected={selected.has(it.id)}
                  onToggle={toggleSelected}
                />
                );
              })}
            </div>
            {/* The next lot of posters is drawn about two screens before you reach the end of what is drawn. */}
            {shownCount < shownItems.length && (
              <LoadMore key={shownCount} onMore={() => setMore({ key: viewKey, n: shownCount + PAGE_SIZE })} />
            )}
          </>
        )}
      </div>

      {/* ⋮ > Import: from an MDBList link, or a pasted list of movie titles (matched, with a pick where unsure). */}
      <ImportListSheet
        open={importOpen}
        onOpenChange={setImportOpen}
        listId={listId}
        listName={list.name}
        onList={onListKeys}
        onImported={afterImport}
      />

      {/* Select mode's bar: how many are picked, Select all / Clear, Remove and Done. On a phone it floats just above
          the bottom menu; on a wider screen it sits at the bottom right. */}
      {selecting && (
        <div
          role="toolbar"
          aria-label="Selected posters"
          className="fixed z-40 inset-x-3 bottom-[calc(max(2.5rem,env(safe-area-inset-bottom))+5rem)] md:inset-x-auto md:right-10 md:bottom-6 flex items-center gap-2 rounded-full border border-white/15 bg-background/95 p-2 pl-4 shadow-2xl shadow-black/50"
        >
          <span className="text-sm font-medium whitespace-nowrap">{selected.size} selected</span>
          <button
            onClick={() =>
              setSelected(selected.size === shownItems.length ? new Set() : new Set(shownItems.map((it) => it.id)))
            }
            className="rounded-full px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground whitespace-nowrap"
          >
            {selected.size === shownItems.length && shownItems.length > 0 ? "Clear" : "Select all"}
          </button>
          <button
            onClick={() => {
              const items = (list.items ?? [])
                .filter((it) => selected.has(it.id))
                .map((it) => ({ mediaType: it.media_type as "movie" | "tv", tmdbId: it.tmdb_id }));
              if (items.length === 0) return;
              if (confirm(`Remove ${items.length} ${items.length === 1 ? "title" : "titles"} from "${list.name}"?`)) {
                removeSelected.mutate(items);
              }
            }}
            disabled={selected.size === 0 || removeSelected.isPending}
            className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-destructive px-4 py-2 text-sm font-semibold text-white disabled:opacity-40 whitespace-nowrap"
          >
            <Trash2 className="size-4" /> {removeSelected.isPending ? "Removing…" : "Remove"}
          </button>
          <button
            onClick={stopSelecting}
            aria-label="Done selecting"
            title="Done"
            className="size-9 shrink-0 grid place-items-center rounded-full bg-surface border border-border"
          >
            <X className="size-4" />
          </button>
        </div>
      )}
    </>
  );
}