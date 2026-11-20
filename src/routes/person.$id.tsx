import { createFileRoute, notFound } from "@tanstack/react-router";
import { useQuery, queryOptions } from "@tanstack/react-query";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Cake, Calendar, Flame, MapPin, Star, Type, User } from "lucide-react";
import { getPerson } from "@/lib/tmdb.functions";
import { PosterCard } from "@/components/media/PosterCard";
import { LoadMore } from "@/components/media/LoadMore";
import { ReadMore } from "@/components/media/ReadMore";
import { img, titleOf, type MediaItem, type PersonDetails } from "@/lib/tmdb";
import { formatDateAULong } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const personQuery = (id: number) =>
  queryOptions({ queryKey: ["person", id], queryFn: () => getPerson({ data: { id } }), staleTime: 1000 * 60 * 60 });

export const Route = createFileRoute("/person/$id")({
  beforeLoad: ({ params }) => {
    if (!/^[1-9]\d*$/.test(params.id)) throw notFound();
  },
  // As a movie page: a page opened directly is drawn on the server, which waits for the details; a tap inside the app
  // changes the page at once (with the placeholder below) and fetches the details alongside.
  loader: ({ context, params }) => {
    const query = personQuery(Number(params.id));
    if (typeof window === "undefined") return context.queryClient.ensureQueryData(query);
    void context.queryClient.prefetchQuery(query);
    return context.queryClient.getQueryData(query.queryKey);
  },
  head: ({ loaderData }) => ({ meta: [{ title: loaderData ? `${loaderData.name} — Popcornhour` : "Person — Popcornhour" }] }),
  component: PersonPage,
  pendingComponent: PersonSkeleton,
});

// ---------------------------------------------------------------------------------------------------------------
// Credits

/** One title on the person's page: the poster, plus what they did on it ("Bruce Wayne", "Director, Writer"). */
type Credit = MediaItem & { key: string; note: string };
/** Everything they did in one line of work (Acting, Directing, Writing…). */
type Dept = { name: string; credits: Credit[] };

// Talk shows and news: an actor's list is full of chat-show and news appearances as themselves. Left out (as are
// archive-footage credits, below).
const HIDDEN_GENRES = new Set([10767, 10763]);

/**
 * The credits grouped by line of work, the one they are known for first, then the biggest. A title they had several
 * roles or jobs on (within one line of work) shows once, with the roles joined. Titles without a poster are left out,
 * as before (in a poster grid they are blank boxes, and nearly always obscure).
 */
function groupCredits(p: PersonDetails): Dept[] {
  const groups = new Map<string, Map<string, { item: MediaItem; notes: string[]; eps: number }>>();
  const add = (dept: string, item: MediaItem, note: string | undefined, eps: number | undefined) => {
    if (!item.poster_path || item.genre_ids?.some((g) => HIDDEN_GENRES.has(g))) return;
    const key = `${item.media_type}-${item.id}`;
    let group = groups.get(dept);
    if (!group) groups.set(dept, (group = new Map()));
    const seen = group.get(key);
    const n = note?.trim();
    if (seen) {
      if (n && !seen.notes.includes(n)) seen.notes.push(n);
      seen.eps = Math.max(seen.eps, eps ?? 0);
    } else {
      group.set(key, { item, notes: n ? [n] : [], eps: eps ?? 0 });
    }
  };
  for (const c of p.combined_credits?.cast ?? []) {
    // Old clips of them reused in someone else's documentary ("Self (archive footage)"): not something they made.
    if (/archive footage/i.test(c.character ?? "")) continue;
    add("Acting", c, c.character, c.episode_count);
  }
  for (const c of p.combined_credits?.crew ?? []) add(c.department || "Crew", c, c.job, c.episode_count);

  const depts: Dept[] = [...groups].map(([name, group]) => ({
    name,
    credits: [...group].map(([key, { item, notes, eps }]) => {
      // A show they were in for a while also says for how long: "Walter White · 62 eps".
      const epsText = item.media_type === "tv" && eps > 0 ? `${eps} ${eps === 1 ? "ep" : "eps"}` : "";
      return { ...item, key, note: [notes.join(", "), epsText].filter(Boolean).join(" · ") };
    }),
  }));
  const known = p.known_for_department;
  return depts.sort((a, b) => Number(b.name === known) - Number(a.name === known) || b.credits.length - a.credits.length);
}

type SortKey = "popular" | "release" | "name" | "rating";
type SortChoice = { key: SortKey; dir: "asc" | "desc" };
const SORTS: { value: SortKey; label: string; icon: React.ComponentType<{ className?: string }>; dir: "asc" | "desc" }[] = [
  { value: "popular", label: "Popularity", icon: Flame, dir: "desc" },
  { value: "release", label: "Release date", icon: Calendar, dir: "desc" },
  { value: "name", label: "Name", icon: Type, dir: "asc" },
  { value: "rating", label: "Rating", icon: Star, dir: "desc" },
];
const DEFAULT_SORT: SortChoice = { key: "popular", dir: "desc" };
// The order picked is remembered on this device, the same for every person.
const SORT_KEY = "cx:person-sort";
function readSort(): SortChoice {
  try {
    const p = JSON.parse(localStorage.getItem(SORT_KEY) ?? "null");
    if (SORTS.some((s) => s.value === p?.key) && (p.dir === "asc" || p.dir === "desc")) return p;
  } catch {
    /* nothing saved, or no storage */
  }
  return DEFAULT_SORT;
}

// A score from a handful of votes says little, so under this many votes a title goes last for Rating.
const MIN_VOTES = 10;
const dateOf = (c: MediaItem) => c.release_date || c.first_air_date || "";
const byName = (a: MediaItem, b: MediaItem) => titleOf(a).localeCompare(titleOf(b), undefined, { sensitivity: "base" });

/** Popularity = how many people rated it on TMDB. Titles with no date (not announced yet) always go last. */
function sortCredits(list: Credit[], { key, dir }: SortChoice): Credit[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...list].sort((a, b) => {
    switch (key) {
      case "popular":
        return sign * ((a.vote_count ?? 0) - (b.vote_count ?? 0)) || byName(a, b);
      case "release": {
        const da = dateOf(a);
        const db = dateOf(b);
        if (!da !== !db) return da ? -1 : 1;
        return sign * da.localeCompare(db) || byName(a, b);
      }
      case "name":
        return sign * byName(a, b);
      case "rating": {
        const ra = (a.vote_count ?? 0) >= MIN_VOTES;
        const rb = (b.vote_count ?? 0) >= MIN_VOTES;
        if (ra !== rb) return ra ? -1 : 1;
        return sign * ((a.vote_average ?? 0) - (b.vote_average ?? 0)) || (b.vote_count ?? 0) - (a.vote_count ?? 0);
      }
    }
  });
}

/** Posters drawn at a time (as in the Library): about ten rows on a phone. The next lot is drawn as you near the end. */
const PAGE_SIZE = 30;

/**
 * What a person's page was last showing, kept while the app stays open (as the Library's and a list's `lastView`).
 * Opening a movie from here and coming Back puts back the same line of work, order and number of posters, so the
 * router can return you to where you had scrolled. Only ever written in the browser (inside an effect).
 */
let lastView: { personId: number; entry: string | undefined; dept: string; sort: SortChoice; more: { key: string; n: number } } | null = null;

/** The router's id for the browser-history entry now showing. */
function historyEntry(): string | undefined {
  return typeof window === "undefined" ? undefined : (window.history.state?.__TSR_key as string | undefined);
}

/** One poster. Memoised: drawing the next lot does not redraw the posters already there. */
const CreditTile = memo(function CreditTile({ credit }: { credit: Credit }) {
  return <PosterCard item={credit} size="fill" note={credit.note || undefined} />;
});

// ---------------------------------------------------------------------------------------------------------------
// About

/** Whole years between two dates ("1970-07-30" to today, or to the day they died). */
function yearsBetween(from: string, to?: string | null): number | null {
  const a = new Date(from);
  const b = to ? new Date(to) : new Date();
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return null;
  let years = b.getFullYear() - a.getFullYear();
  if (b.getMonth() < a.getMonth() || (b.getMonth() === a.getMonth() && b.getDate() < a.getDate())) years--;
  return years >= 0 ? years : null;
}

/** The biography, cut to six lines with a "Read more" button (see ReadMore). */
function Biography({ text }: { text: string }) {
  const sectionRef = useRef<HTMLElement>(null);
  return (
    <section ref={sectionRef} className="px-4 md:px-10 max-w-4xl scroll-mt-16">
      <h2 className="text-lg md:text-xl font-semibold mb-2">Biography</h2>
      <ReadMore text={text} lines={6} scrollTo={sectionRef} />
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Page

// The wide picture across the top: a still from the title they are best known for. Same files as a movie page's.
const BACKDROP_BOX = "relative aspect-[16/10] md:aspect-[21/9] max-h-[460px] overflow-hidden bg-surface";
const PHOTO_BOX = "w-28 md:w-48 aspect-[2/3] shrink-0 rounded-2xl ring-1 ring-border shadow-2xl";
const HEAD_ROW = "px-4 md:px-10 -mt-20 md:-mt-40 relative flex flex-row items-end gap-4 md:gap-8";
const FADE = "absolute inset-0 bg-gradient-to-t from-background from-0% via-background/60 via-40% to-background/10";

function PersonPage() {
  const id = Number(Route.useParams().id);
  const known = Route.useLoaderData();
  const { data: p, error } = useQuery({ ...personQuery(id), ...(known ? { initialData: known } : {}) });
  if (!p && error) throw error; // shown by the app's error page
  if (!p) return <PersonSkeleton />;
  return <PersonDetailsView p={p} />;
}

function PersonDetailsView({ p }: { p: PersonDetails }) {
  const depts = useMemo(() => groupCredits(p), [p]);
  // The picture at the top: the best-known title of all they did that has one.
  const backdrop = useMemo(() => {
    let best: Credit | undefined;
    for (const d of depts) for (const c of d.credits) if (c.backdrop_path && (!best || (c.vote_count ?? 0) > (best.vote_count ?? 0))) best = c;
    return best?.backdrop_path ?? null;
  }, [depts]);

  // Coming Back to this page (the same history entry, e.g. from a movie) puts back what was showing.
  const returning = lastView && lastView.personId === p.id && lastView.entry === historyEntry() ? lastView : null;
  const [deptName, setDeptName] = useState(returning?.dept ?? depts[0]?.name ?? "");
  const [sort, setSort] = useState<SortChoice>(lastView?.sort ?? DEFAULT_SORT);
  // Read after mount so the server and first browser render agree (not needed once known: see `lastView`).
  useEffect(() => {
    if (!lastView) setSort(readSort());
  }, []);
  const chooseSort = (next: SortChoice) => {
    setSort(next);
    try {
      localStorage.setItem(SORT_KEY, JSON.stringify(next));
    } catch {
      /* not saved; still applies now */
    }
  };
  const dept = depts.find((d) => d.name === deptName) ?? depts[0];
  const sorted = useMemo(() => (dept ? sortCredits(dept.credits, sort) : []), [dept, sort]);

  // How many posters are drawn, for one view only: another line of work or order starts again at one page.
  const viewKey = `${dept?.name}|${sort.key}|${sort.dir}`;
  const [more, setMore] = useState<{ key: string; n: number }>(returning?.more ?? { key: "", n: PAGE_SIZE });
  const shownCount = more.key === viewKey ? more.n : PAGE_SIZE;
  const showMore = useCallback(() => setMore({ key: viewKey, n: shownCount + PAGE_SIZE }), [viewKey, shownCount]);
  const ownEntry = useRef<string | undefined>(undefined);
  useEffect(() => {
    ownEntry.current ??= historyEntry();
    lastView = { personId: p.id, entry: ownEntry.current, dept: dept?.name ?? "", sort, more };
  }, [p.id, dept, sort, more]);

  const activeSort = SORTS.find((s) => s.value === sort.key)!;
  const age = p.birthday ? yearsBetween(p.birthday, p.deathday) : null;

  return (
    <article className="space-y-8 md:space-y-10 pb-12">
      <header className="relative">
        <div className={BACKDROP_BOX}>
          {backdrop && (
            <img
              src={img(backdrop, "w1280")!}
              srcSet={`${img(backdrop, "w780")} 780w, ${img(backdrop, "w1280")} 1280w`}
              sizes="(max-width: 767px) 60vw, 100vw"
              alt=""
              decoding="async"
              fetchPriority="high"
              className="absolute inset-0 w-full h-full object-cover"
            />
          )}
          <div className={FADE} />
        </div>
        <div className={HEAD_ROW}>
          {p.profile_path ? (
            <img src={img(p.profile_path, "w342")!} alt={p.name} className={`${PHOTO_BOX} object-cover bg-surface`} />
          ) : (
            <div className={`${PHOTO_BOX} grid place-items-center bg-surface text-muted-foreground`}>
              <User className="size-10" />
            </div>
          )}
          <div className="min-w-0 flex-1 space-y-1.5 md:space-y-3 pb-1">
            <h1 className="text-2xl md:text-5xl font-bold tracking-tight leading-tight break-words">{p.name}</h1>
            {p.known_for_department && (
              <p className="text-sm md:text-base font-medium text-primary">Known for {p.known_for_department}</p>
            )}
            <div className="space-y-1 text-xs md:text-sm text-muted-foreground">
              {p.birthday && (
                <p className="flex items-start gap-1.5">
                  <Cake className="size-3.5 md:size-4 shrink-0 mt-px" />
                  <span>
                    {formatDateAULong(p.birthday)}
                    {!p.deathday && age !== null && ` · ${age} years old`}
                  </span>
                </p>
              )}
              {p.deathday && (
                <p className="flex items-start gap-1.5">
                  <span className="w-3.5 md:w-4 shrink-0 text-center leading-none" aria-hidden>†</span>
                  <span>
                    Died {formatDateAULong(p.deathday)}
                    {age !== null && ` · aged ${age}`}
                  </span>
                </p>
              )}
              {p.place_of_birth && (
                <p className="flex items-start gap-1.5">
                  <MapPin className="size-3.5 md:size-4 shrink-0 mt-px" />
                  <span className="line-clamp-2">{p.place_of_birth}</span>
                </p>
              )}
            </div>
          </div>
        </div>
      </header>

      {p.biography && <Biography key={p.id} text={p.biography} />}

      {dept && (
        <section className="px-4 md:px-10 space-y-4">
          <div className="flex items-center gap-3">
            <div className="min-w-0">
              <h2 className="text-lg md:text-xl font-semibold leading-tight">Credits</h2>
              <p className="text-xs text-muted-foreground">
                {sorted.length} {sorted.length === 1 ? "title" : "titles"}
              </p>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="ml-auto inline-flex items-center gap-2 rounded-full bg-surface border border-border px-3 py-1.5 text-xs hover:border-primary/50">
                  <activeSort.icon className="size-3.5" />
                  {activeSort.label}
                  {sort.dir === "asc" ? <ArrowUp className="size-3.5" /> : <ArrowDown className="size-3.5" />}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                {SORTS.map((s) => (
                  <DropdownMenuItem
                    key={s.value}
                    // A new order starts the natural way round (newest, most popular, best rated, A to Z).
                    onClick={() => chooseSort({ key: s.value, dir: s.value === sort.key ? sort.dir : s.dir })}
                    className={sort.key === s.value ? "bg-primary/15 text-primary" : ""}
                  >
                    <s.icon className="size-4" />
                    {s.label}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => chooseSort({ ...sort, dir: sort.dir === "asc" ? "desc" : "asc" })}>
                  {sort.dir === "asc" ? <ArrowUp className="size-4" /> : <ArrowDown className="size-4" />}
                  {sort.dir === "asc" ? "Ascending" : "Descending"}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Acting / Directing / Writing… only for people with more than one line of work. Slides sideways on a phone. */}
          {depts.length > 1 && (
            <div className="-mx-4 px-4 md:mx-0 md:px-0 overflow-x-auto scrollbar-none">
              <div className="inline-flex bg-surface border border-border rounded-full p-1" role="group" aria-label="Line of work">
                {depts.map((d) => (
                  <button
                    key={d.name}
                    onClick={() => setDeptName(d.name)}
                    aria-pressed={dept.name === d.name}
                    className={[
                      "px-4 py-2 text-sm font-medium rounded-full whitespace-nowrap",
                      dept.name === d.name ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                    ].join(" ")}
                  >
                    {d.name}
                    <span className={`ml-1.5 text-xs ${dept.name === d.name ? "opacity-80" : "opacity-60"}`}>{d.credits.length}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-x-3 md:gap-x-4 gap-y-5 md:gap-y-6">
            {sorted.slice(0, shownCount).map((c) => (
              <CreditTile key={c.key} credit={c} />
            ))}
          </div>
          {/* The next lot of posters is drawn about two screens before you reach the end of what is drawn. */}
          {shownCount < sorted.length && <LoadMore key={shownCount} onMore={showMore} />}
        </section>
      )}
    </article>
  );
}

const BAR = "rounded-full bg-surface animate-pulse";

/** Shown the moment a person is tapped, until their details arrive: the same boxes as the real page. */
function PersonSkeleton() {
  return (
    <article className="space-y-8 md:space-y-10 pb-12" aria-busy="true">
      <header className="relative">
        <div className={BACKDROP_BOX}>
          <div className={FADE} />
        </div>
        <div className={HEAD_ROW}>
          <div className={`${PHOTO_BOX} bg-surface animate-pulse`} />
          <div className="min-w-0 flex-1 space-y-3 pb-1">
            <div className={`${BAR} h-7 md:h-12 w-3/4`} />
            <div className={`${BAR} h-4 w-1/2`} />
            <div className={`${BAR} h-3.5 w-2/3`} />
            <div className={`${BAR} h-3.5 w-1/2`} />
          </div>
        </div>
      </header>
      <section className="px-4 md:px-10 max-w-4xl space-y-3">
        <div className={`${BAR} h-5 w-28`} />
        <div className={`${BAR} h-4 w-full`} />
        <div className={`${BAR} h-4 w-full`} />
        <div className={`${BAR} h-4 w-2/3`} />
      </section>
      <span className="sr-only">Loading…</span>
    </article>
  );
}
