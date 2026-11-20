import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Check, ChevronLeft, ChevronRight, ChevronUp, History, MessageSquare } from "lucide-react";
import { episodeQuery, seasonQuery, tvQuery } from "@/lib/tv-query";
import { formatRuntime, img, type CastMember, type CrewMember } from "@/lib/tmdb";
import { formatDateAULong, formatDateTimeAU } from "@/lib/utils";
import { DetailBackdrop } from "@/components/media/DetailHero";
import { RatingsBar } from "@/components/media/RatingsBar";
import { CommentsList, useComments } from "@/components/media/CommentsDialog";
import { useEpisodeWatching } from "@/hooks/use-episode-watching";

export const Route = createFileRoute("/tv/$id/season/$seasonNumber_/episode/$episodeNumber")({
  // Like a movie page: drawn in full on the server when opened directly, but a tap inside the app changes the page
  // at once (with what the season page already knows about the episode) and fetches the rest alongside.
  loader: ({ context, params }) => {
    const query = episodeQuery(Number(params.id), Number(params.seasonNumber), Number(params.episodeNumber));
    if (typeof window === "undefined") return context.queryClient.ensureQueryData(query);
    void context.queryClient.prefetchQuery(query);
    void context.queryClient.prefetchQuery(seasonQuery(Number(params.id), Number(params.seasonNumber)));
    return context.queryClient.getQueryData(query.queryKey);
  },
  head: ({ loaderData }) => ({ meta: [{ title: `${loaderData?.name ?? "Episode"} — Popcornhour` }] }),
  component: EpisodePage,
});

/** People's names as links to their pages, joined with commas. */
function People({ people }: { people: { id: number; name: string }[] }) {
  return (
    <>
      {people.map((p, i) => (
        <span key={p.id}>
          {i > 0 && ", "}
          <Link to="/person/$id" params={{ id: String(p.id) }} className="font-medium text-foreground hover:text-primary hover:underline">
            {p.name}
          </Link>
        </span>
      ))}
    </>
  );
}

const uniqueById = <T extends { id: number }>(list: T[]) => list.filter((x, i) => list.findIndex((y) => y.id === x.id) === i);

function EpisodePage() {
  const { id, seasonNumber, episodeNumber } = Route.useParams();
  const tvId = Number(id);
  const sn = Number(seasonNumber);
  const en = Number(episodeNumber);
  const known = Route.useLoaderData();
  const { data: full, error } = useQuery({ ...episodeQuery(tvId, sn, en), ...(known ? { initialData: known } : {}) });
  const { data: season } = useQuery(seasonQuery(tvId, sn));
  const { data: show } = useQuery(tvQuery(tvId));
  const episodes = season?.episodes ?? [];
  // What is drawn at once: the full details, or the season's short version of this episode until they arrive.
  const ep = full ?? episodes.find((e) => e.episode_number === en);
  const { user, progress, watchedSet, watchedAtMap, onCheck, dialogs } = useEpisodeWatching(tvId, sn, episodes);
  const showImdb = show?.external_ids?.imdb_id ?? null;
  // Comments stay hidden (and are not looked up) until asked for. A new episode starts hidden again.
  const [commentsOpen, setCommentsOpen] = useState(false);
  useEffect(() => setCommentsOpen(false), [id, seasonNumber, episodeNumber]);
  const comments = useComments({ reviews: [], imdbId: showImdb, mediaType: "tv", season: sn, episode: en }, commentsOpen);
  if (!ep && error) throw error; // shown by the app's error page

  // The episodes either side, crossing into the next or previous season (specials are left out).
  const regular = (show?.seasons ?? []).filter((x) => x.season_number > 0 && x.episode_count > 0);
  const index = episodes.findIndex((e) => e.episode_number === en);
  const prevSeason = regular.filter((x) => x.season_number < sn).at(-1);
  const nextSeason = regular.find((x) => x.season_number > sn);
  const prev =
    index > 0
      ? { sn, en: episodes[index - 1].episode_number, label: episodes[index - 1].name }
      : index === 0 && prevSeason && sn > 0
        ? { sn: prevSeason.season_number, en: prevSeason.episode_count, label: `${prevSeason.name}, last episode` }
        : null;
  const next =
    index >= 0 && index < episodes.length - 1
      ? { sn, en: episodes[index + 1].episode_number, label: episodes[index + 1].name }
      : index === episodes.length - 1 && nextSeason && sn > 0
        ? { sn: nextSeason.season_number, en: 1, label: `${nextSeason.name}, episode 1` }
        : null;

  const crew: CrewMember[] = full?.crew ?? [];
  const directors = uniqueById(crew.filter((c) => c.job === "Director"));
  const writers = uniqueById(crew.filter((c) => c.job === "Writer" || c.job === "Teleplay" || c.job === "Story"));
  // Regulars first, then the guest stars (marked), each person once.
  const regulars: CastMember[] = full?.credits?.cast ?? [];
  const guests: CastMember[] = full?.guest_stars ?? full?.credits?.guest_stars ?? [];
  const cast = uniqueById([...regulars, ...guests]).slice(0, 30);
  const guestIds = new Set(guests.map((g) => g.id));
  const stills = full?.images?.stills ?? [];
  const watched = watchedSet.has(en);
  const watchedAt = watchedAtMap.get(en) ?? null;
  const meta = [ep?.air_date ? formatDateAULong(ep.air_date) : null, ep?.runtime ? formatRuntime(ep.runtime) : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <article className="space-y-8 pb-12">
      <header className="relative">
        {/* The episode's own picture across the top (the show's while there is none). */}
        <DetailBackdrop path={ep?.still_path ?? show?.backdrop_path}>
          <div className="absolute inset-0 bg-gradient-to-t from-background from-0% via-background/55 via-35% to-transparent to-75%" />
        </DetailBackdrop>
        <div className="px-4 md:px-10 -mt-12 md:-mt-28 relative space-y-1.5 md:space-y-2">
          {/* Which episode, as one short label (tap for the season). The show is the floating button at the top
              right on a phone; larger screens get its name here too. */}
          <p className="flex flex-wrap items-baseline gap-x-2 text-xs md:text-sm font-semibold uppercase tracking-wide">
            <Link to="/tv/$id/season/$seasonNumber" params={{ id, seasonNumber }} className="text-primary hover:underline">
              {sn === 0 ? `Special ${en}` : `S${sn} · E${en}`}
            </Link>
            {show?.name && (
              <Link to="/tv/$id" params={{ id }} className="hidden md:inline text-muted-foreground hover:text-primary">
                {show.name}
              </Link>
            )}
          </p>
          <h1 className="text-2xl md:text-5xl font-bold tracking-tight break-words leading-tight">{ep?.name ?? `Episode ${en}`}</h1>
          {meta && <p className="text-xs md:text-sm text-muted-foreground">{meta}</p>}
          {directors.length > 0 && (
            <p className="text-xs md:text-sm text-muted-foreground">Directed by <People people={directors} /></p>
          )}
          {writers.length > 0 && (
            <p className="text-xs md:text-sm text-muted-foreground">Written by <People people={writers} /></p>
          )}
        </div>
        <div className="px-4 md:px-10 mt-4 md:mt-6 space-y-4">
          <RatingsBar
            imdbId={full?.external_ids?.imdb_id}
            mediaType="tv"
            tmdbScore={ep?.vote_average}
            tmdbVotes={full?.vote_count}
          />
          {user && (
            <div className="space-y-2 md:max-w-sm">
              {/* The same as the tick on the season page: asks when (and the rating), or opens the watch history. */}
              <button
                onClick={() => ep && onCheck(ep)}
                disabled={!ep || !progress}
                className={[
                  "h-12 w-full rounded-full inline-flex items-center justify-center gap-2 text-sm font-medium border transition disabled:opacity-60",
                  watched
                    ? "bg-primary/20 border-primary/50 text-primary"
                    : "bg-surface border-border text-foreground hover:border-primary/50",
                ].join(" ")}
              >
                {watched ? <History className="size-4" /> : <Check className="size-4" />}
                {watched ? "Watched" : "Mark as watched"}
              </button>
              {watched && watchedAt && (
                <p className="text-center text-xs text-muted-foreground">Watched {formatDateTimeAU(watchedAt)}</p>
              )}
            </div>
          )}
        </div>
      </header>

      <section className="px-4 md:px-10 max-w-4xl">
        <h2 className="text-lg font-semibold mb-2">Overview</h2>
        <p className="text-muted-foreground leading-relaxed whitespace-pre-line">{ep?.overview || "No overview available."}</p>
      </section>

      {cast.length > 0 && (
        <div className="px-4 md:px-10">
          <h2 className="text-lg md:text-xl font-semibold mb-3">Cast</h2>
          <div className="flex gap-3 overflow-x-auto scrollbar-none -mx-4 px-4 md:-mx-10 md:px-10 pb-1">
            {cast.map((c) => (
              <Link key={c.id} to="/person/$id" params={{ id: String(c.id) }} className="w-28 shrink-0 group">
                <div className="relative aspect-[2/3] rounded-xl overflow-hidden bg-surface ring-1 ring-border">
                  {c.profile_path ? (
                    <img src={img(c.profile_path, "w185")!} alt={c.name} loading="lazy" className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" />
                  ) : (
                    <div className="w-full h-full grid place-items-center text-xs text-muted-foreground">No photo</div>
                  )}
                  {guestIds.has(c.id) && (
                    <span className="absolute left-1.5 top-1.5 rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-semibold text-white">Guest</span>
                  )}
                </div>
                <p className="mt-2 text-xs font-medium line-clamp-1">{c.name}</p>
                <p className="text-xs text-muted-foreground line-clamp-1">{c.character}</p>
              </Link>
            ))}
          </div>
        </div>
      )}

      {stills.length > 1 && (
        <div className="px-4 md:px-10">
          <h2 className="text-lg md:text-xl font-semibold mb-3">Stills</h2>
          <div className="flex gap-3 overflow-x-auto scrollbar-none -mx-4 px-4 md:-mx-10 md:px-10 pb-1">
            {stills.slice(0, 20).map((st) => (
              <img
                key={st.file_path}
                src={img(st.file_path, "w300")!}
                alt=""
                loading="lazy"
                decoding="async"
                className="w-56 shrink-0 aspect-video rounded-xl object-cover bg-surface ring-1 ring-border"
              />
            ))}
          </div>
        </div>
      )}

      {/* The episode's comments on Trakt, most liked first, with "Load more". Hidden behind a button: the list
          is long. */}
      {showImdb && (
        <section className="px-4 md:px-10 max-w-4xl">
          <h2 className="text-lg md:text-xl font-semibold mb-3">
            Comments
            {commentsOpen && comments.total > 0 && (
              <span className="ml-2 text-sm font-normal text-muted-foreground">{comments.total.toLocaleString()}</span>
            )}
          </h2>
          {commentsOpen ? (
            <>
              <CommentsList comments={comments} />
              <button
                type="button"
                onClick={() => setCommentsOpen(false)}
                className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline"
              >
                Hide comments <ChevronUp className="size-4" />
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setCommentsOpen(true)}
              className="h-11 w-full md:w-auto md:px-6 rounded-full inline-flex items-center justify-center gap-2 border border-border bg-surface text-sm font-medium transition hover:border-primary/50"
            >
              <MessageSquare className="size-4" /> Show comments
            </button>
          )}
        </section>
      )}

      {/* Stepping through episodes swaps this page in place (`replace`), so Back goes to where you came from
          (the season) rather than through every episode passed on the way. */}
      {(prev || next) && (
        <nav className="px-4 md:px-10 grid grid-cols-2 gap-3" aria-label="Other episodes">
          {prev ? (
            <Link
              to="/tv/$id/season/$seasonNumber/episode/$episodeNumber"
              params={{ id, seasonNumber: String(prev.sn), episodeNumber: String(prev.en) }}
              replace
              className="flex items-center gap-2 rounded-2xl bg-surface p-3 transition hover:bg-surface/70 active:scale-[0.99]"
            >
              <ChevronLeft className="size-5 shrink-0 text-muted-foreground" />
              <span className="min-w-0">
                <span className="block text-[11px] uppercase tracking-wide text-muted-foreground">Previous</span>
                <span className="block text-sm font-medium line-clamp-1">{prev.label}</span>
              </span>
            </Link>
          ) : <span />}
          {next ? (
            <Link
              to="/tv/$id/season/$seasonNumber/episode/$episodeNumber"
              params={{ id, seasonNumber: String(next.sn), episodeNumber: String(next.en) }}
              replace
              className="flex items-center justify-end gap-2 rounded-2xl bg-surface p-3 text-right transition hover:bg-surface/70 active:scale-[0.99]"
            >
              <span className="min-w-0">
                <span className="block text-[11px] uppercase tracking-wide text-muted-foreground">Next</span>
                <span className="block text-sm font-medium line-clamp-1">{next.label}</span>
              </span>
              <ChevronRight className="size-5 shrink-0 text-muted-foreground" />
            </Link>
          ) : <span />}
        </nav>
      )}
      {dialogs}
    </article>
  );
}
