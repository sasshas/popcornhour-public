import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowDown, ArrowUp, Check, ChevronRight, Play, Tv } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useLibraryStatus } from "@/hooks/use-library-status";
import { listEpisodeProgress } from "@/lib/library.functions";
import { img, type Season } from "@/lib/tmdb";
import { getShowRuntimes, type EpisodeRuntime } from "@/lib/tmdb.functions";

/**
 * Minutes left to watch: every episode out so far (aired by today) that is not ticked as watched. An episode
 * TMDB has no length for counts as the show's usual length (the average of the ones it has). Null when there is
 * nothing left, or no lengths at all to go on.
 */
function minutesLeft(episodes: EpisodeRuntime[], watched: { season_number: number; episode_number: number }[]): number | null {
  const today = new Date().toISOString().slice(0, 10);
  const seen = new Set(watched.map((w) => `${w.season_number}:${w.episode_number}`));
  const known = episodes.map((e) => e[2]).filter((r): r is number => !!r);
  if (known.length === 0) return null;
  const usual = known.reduce((a, b) => a + b, 0) / known.length;
  let total = 0;
  for (const [season, episode, runtime, airDate] of episodes) {
    if (!airDate || airDate > today || seen.has(`${season}:${episode}`)) continue;
    total += runtime ?? usual;
  }
  return total >= 1 ? Math.round(total) : null;
}

/** "3h 23m", "45m", "293h 20m". */
function formatMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}
import { setSeasonsNewestFirst, useSeasonsNewestFirst, useShowSpecials } from "@/hooks/use-season-prefs";

/**
 * A show's seasons as a list of cards: a small poster, the name, the year and episode count, and (once a season has
 * started) a bar of how many of its episodes are watched. The arrow beside the heading flips newest-first and
 * oldest-first; Specials always come last, and can be hidden in Settings > Appearance.
 */
export function SeasonList({ tvId, seasons }: { tvId: number; seasons: Season[] }) {
  const { user } = useAuth();
  const newestFirst = useSeasonsNewestFirst();
  const showSpecials = useShowSpecials();
  const showWatching = useLibraryStatus()("tv", tvId).watching;
  const fetchProgress = useServerFn(listEpisodeProgress);
  // The same lookup (and key) as the season page, so ticking an episode there is already counted here on Back.
  const { data: progress } = useQuery({
    queryKey: ["episode-progress", tvId, user?.id ?? null],
    queryFn: () => fetchProgress({ data: { tvTmdbId: tvId } }),
    enabled: !!user,
  });
  const watchedBySeason = new Map<number, number>();
  for (const p of progress ?? []) watchedBySeason.set(p.season_number, (watchedBySeason.get(p.season_number) ?? 0) + 1);

  // Every episode's length, for the time left beside the heading. Specials are not counted.
  const seasonNumbers = seasons.filter((s) => s.season_number > 0).map((s) => s.season_number).sort((a, b) => a - b);
  const fetchRuntimes = useServerFn(getShowRuntimes);
  const { data: runtimes } = useQuery({
    queryKey: ["show-runtimes", tvId, seasonNumbers.join(",")],
    queryFn: () => fetchRuntimes({ data: { id: tvId, seasons: seasonNumbers } }),
    enabled: !!user && seasonNumbers.length > 0,
    staleTime: 1000 * 60 * 60,
  });
  const remaining = runtimes && progress ? minutesLeft(runtimes, progress) : null;

  const regular = seasons.filter((s) => s.season_number > 0).sort((a, b) => a.season_number - b.season_number);
  if (newestFirst) regular.reverse();
  const specials = showSpecials ? seasons.filter((s) => s.season_number === 0) : [];
  const list = [...regular, ...specials];
  if (list.length === 0) return null;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <section className="px-4 md:px-10">
      <div className="mb-3 flex min-h-9 items-center justify-between gap-3">
        <h2 className="text-lg md:text-xl font-semibold">Seasons</h2>
        {/* Arrives a moment after the page; the row is already the arrow's height, so nothing moves. */}
        {remaining ? (
          <span
            className="ml-auto text-sm text-muted-foreground tabular-nums"
            title="Episodes out so far that you have not watched"
          >
            ~{formatMinutes(remaining)} remaining
          </span>
        ) : null}
        {regular.length > 1 && (
          <button
            type="button"
            onClick={() => setSeasonsNewestFirst(!newestFirst)}
            title={newestFirst ? "Newest first (tap for oldest first)" : "Oldest first (tap for newest first)"}
            aria-label={newestFirst ? "Newest season first. Show oldest first" : "Oldest season first. Show newest first"}
            className="grid size-9 place-items-center rounded-full text-muted-foreground transition hover:bg-surface hover:text-foreground active:scale-95"
          >
            {newestFirst ? <ArrowDown className="size-5" /> : <ArrowUp className="size-5" />}
          </button>
        )}
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {list.map((s) => {
          const year = s.air_date?.slice(0, 4);
          const eps = s.episode_count ? `${s.episode_count} ${s.episode_count === 1 ? "ep" : "eps"}` : null;
          const meta = [year, eps].filter(Boolean).join(" · ");
          // The bar only once a season has started and only for a signed-in user. Its place is kept while the
          // counts load, with the number left off, so the card does not grow.
          const started = !!user && !!s.episode_count && !!s.air_date && s.air_date <= today;
          const watched = Math.min(watchedBySeason.get(s.season_number) ?? 0, s.episode_count);
          const pct = started ? (watched / s.episode_count) * 100 : 0;
          const done = started && watched >= s.episode_count;
          // Partly watched, in a show marked Watching: the blue play icon (the same one its poster carries).
          const inProgress = showWatching && started && !!progress && watched > 0 && !done;
          return (
            <Link
              key={s.id}
              to="/tv/$id/season/$seasonNumber"
              params={{ id: String(tvId), seasonNumber: String(s.season_number) }}
              className="group flex items-center gap-4 rounded-2xl bg-surface p-3 pr-4 transition hover:bg-surface/70 active:scale-[0.99]"
            >
              <div className="w-14 shrink-0 overflow-hidden rounded-lg bg-background/40 ring-1 ring-border aspect-[2/3]">
                {s.poster_path ? (
                  <img src={img(s.poster_path, "w154")!} alt="" loading="lazy" decoding="async" className="size-full object-cover" />
                ) : (
                  <div className="grid size-full place-items-center text-muted-foreground"><Tv className="size-5" /></div>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium line-clamp-1">{s.name}</p>
                    {meta && <p className="text-xs text-muted-foreground mt-0.5">{meta}</p>}
                  </div>
                  {inProgress && (
                    <span
                      className="grid size-7 shrink-0 place-items-center rounded-full border-2 border-blue-200 bg-blue-500 text-white"
                      title="Watching"
                    >
                      <Play className="size-3.5 translate-x-[1px] fill-current" />
                    </span>
                  )}
                  {done && !!progress && (
                    <span
                      className="grid size-7 shrink-0 place-items-center rounded-full border-2 border-green-200 bg-green-500 text-white"
                      title="Watched"
                    >
                      <Check className="size-3.5" strokeWidth={3} />
                    </span>
                  )}
                  <ChevronRight className="size-5 shrink-0 text-muted-foreground transition group-hover:translate-x-0.5" />
                </div>
                {started && (
                  <div className="mt-2.5 flex items-center gap-3">
                    <div className="relative h-1 flex-1 rounded-full bg-foreground/15">
                      <div className="absolute inset-y-0 left-0 rounded-full bg-primary" style={{ width: `${pct}%` }} />
                      {/* The dot marks how far along; it sits at the start when nothing is watched yet. */}
                      <div
                        className="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary"
                        style={{ left: `${pct}%` }}
                      />
                    </div>
                    <span className={`w-12 shrink-0 text-right text-xs tabular-nums ${done ? "text-primary font-medium" : "text-muted-foreground"}`}>
                      {progress ? `${watched}/${s.episode_count}` : ""}
                    </span>
                  </div>
                )}
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
