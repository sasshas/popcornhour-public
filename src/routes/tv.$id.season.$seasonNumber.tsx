import { createFileRoute, Link } from "@tanstack/react-router";
import { useSuspenseQuery, useQuery } from "@tanstack/react-query";
import { seasonQuery, tvQuery } from "@/lib/tv-query";
import { DetailBackdrop, DetailPoster } from "@/components/media/DetailHero";
import { formatRuntime, img } from "@/lib/tmdb";
import { Check, Star } from "lucide-react";
import { useMemo } from "react";
import { formatDateAULong, formatDateTimeAU } from "@/lib/utils";
import { ReadMore } from "@/components/media/ReadMore";
import { WatchedBar } from "@/components/media/WatchedBar";
import { useEpisodeWatching } from "@/hooks/use-episode-watching";

export const Route = createFileRoute("/tv/$id/season/$seasonNumber")({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(seasonQuery(Number(params.id), Number(params.seasonNumber))),
  head: ({ loaderData }) => ({ meta: [{ title: loaderData ? `${loaderData.name} — Popcornhour` : "Season — Popcornhour" }] }),
  component: SeasonPage,
});

function SeasonPage() {
  const { id, seasonNumber } = Route.useParams();
  const { data: s } = useSuspenseQuery(seasonQuery(Number(id), Number(seasonNumber)));
  // The show itself, for its name and wide picture. Usually already loaded (the show page, or its loader).
  const { data: show } = useQuery(tvQuery(Number(id)));
  // When this season opened, for the watched bar on the poster (it waits for the poster to land). Going to
  // another season reuses the page, so it is taken again for each one.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const openedAt = useMemo(() => (typeof performance === "undefined" ? 0 : performance.now()), [id, seasonNumber]);
  const tvId = Number(id);
  const sn = Number(seasonNumber);
  // Which episodes are watched, and the tick on each (the popups it opens are `dialogs`).
  const { user, progress, watchedSet, watchedAtMap, onCheck, dialogs } = useEpisodeWatching(tvId, sn, s.episodes);

  // The header's figures: the season's total length, and what is left of the episodes out so far.
  const today = new Date().toISOString().slice(0, 10);
  const total = s.episodes.reduce((sum, e) => sum + (e.runtime ?? 0), 0);
  const left = s.episodes
    .filter((e) => e.air_date && e.air_date <= today && !watchedSet.has(e.episode_number))
    .reduce((sum, e) => sum + (e.runtime ?? 0), 0);
  const watchedCount = s.episodes.filter((e) => watchedSet.has(e.episode_number)).length;
  const meta = [
    `${s.episodes.length} episode${s.episodes.length === 1 ? "" : "s"}`,
    total ? formatRuntime(total) : null,
    user && progress && left ? `${formatRuntime(left)} left` : null,
  ].filter(Boolean).join(" · ");

  return (
    <article className="space-y-6 pb-12">
      {/* The top of the page is laid out like the show's: the show's wide picture (a season has none of its own),
          and the season's poster beside its name. On a phone the floating Back pill sits over the picture. */}
      <header className="relative">
        <DetailBackdrop path={show?.backdrop_path}>
          <div className="absolute inset-0 bg-gradient-to-t from-background from-0% via-background/55 via-35% to-transparent to-75%" />
        </DetailBackdrop>
        <div className="px-4 md:px-10 -mt-16 md:-mt-32 relative">
          <div className="flex flex-row items-center md:items-start gap-4 md:gap-8">
            <DetailPoster
              path={s.poster_path}
              alt={s.name}
              layout="tv"
              // How many episodes are watched, on the bottom of the poster. It grows in once the poster has landed.
              overlay={
                user && progress && s.episodes.length > 0 ? (
                  <WatchedBar key={`${id}:${seasonNumber}`} watched={watchedCount} total={s.episodes.length} startAt={openedAt} />
                ) : null
              }
            />
            <div className="min-w-0 flex-1 space-y-1.5 md:space-y-2 md:pt-12">
              <Link
                to="/tv/$id"
                params={{ id }}
                className="inline-block text-sm md:text-base font-medium underline underline-offset-4 decoration-foreground/40 hover:text-primary"
              >
                {show?.name ?? "Back to show"}
              </Link>
              <h1 className="text-xl md:text-5xl font-bold tracking-tight break-words leading-tight">{s.name}</h1>
              {s.air_date && <p className="text-xs md:text-sm text-muted-foreground">{formatDateAULong(s.air_date)}</p>}
              <p className="text-xs md:text-sm text-muted-foreground">{meta}</p>
            </div>
          </div>
        </div>
      </header>

      <div className="px-4 md:px-10 space-y-6">
        {/* A whole season's plot can be long: four lines, with "Read more" for the rest. */}
        {s.overview && <ReadMore text={s.overview} lines={4} className="max-w-4xl" />}
        {/* Each episode: a small picture on the left and everything else beside it. Tapping the card opens the
            episode's own page; the tick beside it only marks it watched. */}
        <ul className="space-y-3">
          {s.episodes.map((ep) => {
            const rating = typeof ep.vote_average === "number" && ep.vote_average > 0 ? ep.vote_average : null;
            const watched = watchedSet.has(ep.episode_number);
            return (
              <li key={ep.id} className="flex items-start gap-3 rounded-2xl bg-surface p-3 transition hover:bg-surface/70">
                <Link
                  to="/tv/$id/season/$seasonNumber/episode/$episodeNumber"
                  params={{ id, seasonNumber, episodeNumber: String(ep.episode_number) }}
                  className="flex min-w-0 flex-1 items-start gap-3 active:opacity-80"
                >
                  <div className="w-28 sm:w-44 shrink-0 aspect-video overflow-hidden rounded-lg bg-background ring-1 ring-border">
                    {ep.still_path ? (
                      <img
                        src={img(ep.still_path, "w300")!}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full grid place-items-center text-muted-foreground text-[11px]">No image</div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="text-sm md:text-base font-semibold leading-snug line-clamp-2">
                      <span className="text-muted-foreground mr-1.5">{ep.episode_number}.</span>{ep.name}
                    </h3>
                    {/* Rating, air date and length, each only when TMDB knows it. */}
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                      {rating !== null && (
                        <span className="inline-flex items-center gap-1">
                          <Star className="size-3 fill-[var(--gold)] text-[var(--gold)]" />{rating.toFixed(1)}
                        </span>
                      )}
                      {[ep.air_date ? formatDateAULong(ep.air_date) : null, ep.runtime ? formatRuntime(ep.runtime) : null]
                        .filter(Boolean)
                        .map((t, i) => (
                          <span key={i}>{(i > 0 || rating !== null) && "· "}{t}</span>
                        ))}
                    </p>
                    {ep.overview && <p className="mt-1.5 text-xs md:text-sm text-muted-foreground line-clamp-3">{ep.overview}</p>}
                    {watched && watchedAtMap.get(ep.episode_number) && (
                      <p className="text-xs text-primary mt-1.5">Watched {formatDateTimeAU(watchedAtMap.get(ep.episode_number)!)}</p>
                    )}
                  </div>
                </Link>
                {user && (
                  <button
                    onClick={() => onCheck(ep)}
                    title={watched ? "Watch history" : "Mark watched"}
                    aria-label={watched ? `Episode ${ep.episode_number} watch history` : `Mark episode ${ep.episode_number} watched`}
                    className={[
                      "shrink-0 size-9 grid place-items-center rounded-full border transition self-start",
                      watched
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-background border-border text-muted-foreground hover:text-foreground",
                    ].join(" ")}
                  >
                    <Check className="size-4" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </div>
      {dialogs}
    </article>
  );
}
