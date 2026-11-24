import { createFileRoute, Link, Outlet, useMatches } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { markHeroPoster, peekOf } from "@/lib/peek";
import { tvQuery } from "@/lib/tv-query";
import { MediaRail } from "@/components/media/MediaRail";
import { img, formatRuntime, type TVDetails } from "@/lib/tmdb";
import { displayName, formatDateAULong } from "@/lib/utils";
import { Calendar, CalendarClock, Tv } from "lucide-react";
import { AuRatingBadge, getAuCertification } from "@/components/media/AuRatingBadge";
import { MovieActionBar } from "@/components/media/MovieActionBar";
import { TrailerButton } from "@/components/media/TrailerButton";
import { WatchProviders } from "@/components/media/WatchProviders";
import { RatingsBar } from "@/components/media/RatingsBar";
import { WhatPeopleSay } from "@/components/media/WhatPeopleSay";
import { ParentsGuide } from "@/components/media/ParentsGuide";
import { SeasonList } from "@/components/media/SeasonList";
import { DetailBackdrop, DetailPoster, DetailSkeleton } from "@/components/media/DetailHero";
import { SeeAllCast } from "@/components/media/CastGrid";

export const Route = createFileRoute("/tv/$id")({
  // A page opened directly is drawn on the server, which waits for the details. A tap inside the app does not wait:
  // the page changes at once (so the page-change animation plays on the tap, with the placeholder if the details are
  // not here yet) and the details are fetched alongside. Returns whatever is already known.
  loader: ({ context, params }) => {
    const query = tvQuery(Number(params.id));
    if (typeof window === "undefined") return context.queryClient.ensureQueryData(query);
    void context.queryClient.prefetchQuery(query);
    return context.queryClient.getQueryData(query.queryKey);
  },
  head: ({ loaderData, params }) => ({
    meta: [
      // The name comes from the details, or from the card that was tapped while they are still loading.
      { title: `${loaderData?.name ?? peekOf("tv", params.id)?.title ?? "Show"} — Popcornhour` },
      { name: "description", content: loaderData?.overview?.slice(0, 160) ?? "" },
      ...(loaderData?.backdrop_path ? [{ property: "og:image" as const, content: img(loaderData.backdrop_path, "w1280")! }] : []),
    ],
  }),
  component: TVPage,
  // Only a fallback now: the loader above no longer waits, so the page itself shows the placeholder while its details
  // load. (It must not be set to appear at once: it would be drawn before the router starts the page-change animation,
  // and the tapped poster would have nothing to grow from.)
  pendingComponent: () => <DetailSkeleton layout="tv" />,
});

const today = () => new Date().toISOString().slice(0, 10);

/** The years it ran ("2008–2013"), or "2019–now" while it is still going. A show not on yet gets its start date. */
function airYears(m: TVDetails): string | null {
  if (!m.first_air_date) return null;
  if (m.first_air_date > today()) return formatDateAULong(m.first_air_date);
  const first = m.first_air_date.slice(0, 4);
  if (m.status === "Ended" || m.status === "Canceled") {
    const last = m.last_air_date?.slice(0, 4);
    return last && last !== first ? `${first}–${last}` : first;
  }
  return `${first}–now`;
}

/**
 * The line under "Created by", in the place a movie says whether to stay for the credits: when the next episode is
 * on (highlighted), or else whether the show has ended. Kept short so it fits on one line beside the poster on a phone.
 * "upcoming" is a date for the next episode (in the app's colour); otherwise "over" (ended or cancelled, in red) or
 * "going" (returning, in production or planned, in green).
 */
type AiringTone = "upcoming" | "over" | "going";
function airingLine(m: TVDetails): { text: string; tone: AiringTone } | null {
  const next = m.next_episode_to_air;
  if (next?.air_date) {
    const when = formatDateAULong(next.air_date);
    return next.episode_number === 1
      ? { text: `Season ${next.season_number} starts ${when}`, tone: "upcoming" }
      : { text: `Next: S${next.season_number} E${next.episode_number} · ${when}`, tone: "upcoming" };
  }
  switch (m.status) {
    case "Ended": return { text: "Ended", tone: "over" };
    case "Canceled": return { text: "Cancelled", tone: "over" };
    case "Returning Series": return { text: "Returning series", tone: "going" };
    case "In Production": return { text: "In production", tone: "going" };
    case "Planned": return { text: "Planned", tone: "going" };
    default: return null;
  }
}
const AIRING_TEXT: Record<AiringTone, string> = {
  upcoming: "font-medium text-foreground",
  // A softer red than an error message, so a cancelled show reads as "over" rather than "something went wrong".
  over: "font-medium text-red-400/90",
  going: "font-medium text-emerald-500",
};

function TVPage() {
  const { id } = Route.useParams();
  const matches = useMatches();
  // A season or episode page is drawn inside this one (it is the parent route), in place of the show.
  const isSeasonRoute = matches.some((match) => match.routeId.startsWith("/tv/$id/season/"));
  // The details: what the loader already had (a page drawn on the server, or one opened before), otherwise fetched
  // now, with the placeholder page shown meanwhile.
  const known = Route.useLoaderData();
  const { data: m, error } = useQuery({ ...tvQuery(Number(id)), ...(known ? { initialData: known } : {}) });
  if (!m && error) throw error; // shown by the app's error page
  if (isSeasonRoute) return <Outlet />;
  if (!m) return <DetailSkeleton layout="tv" />;
  const trailer = m.videos?.results.find((v) => v.site === "YouTube" && v.type === "Trailer" && v.official) ?? m.videos?.results.find((v) => v.site === "YouTube" && v.type === "Trailer");
  const imdbId = m.external_ids?.imdb_id ?? null;
  const years = airYears(m);
  const airing = airingLine(m);
  const creators = m.created_by ?? [];
  // The logo in the Details row: the channel or service it is made for (HBO, Netflix...), the first one with a logo.
  // Not tappable: the app has no page for a channel's shows.
  const network = m.networks?.find((n) => n.logo_path);
  // The look-it-up figures for the Details row, low on the page. Only what TMDB knows is listed.
  const runtime = m.episode_run_time?.[0] ?? m.last_episode_to_air?.runtime ?? null;
  const language = m.original_language ? displayName("language", m.original_language) : null;
  const countries = (m.origin_country ?? []).map((c) => displayName("region", c) ?? c);
  const details: { label: string; value: string; title?: string }[] = [
    // A channel with no logo on TMDB still gets its name in the row.
    ...(!network && m.networks?.[0] ? [{ label: "Network", value: m.networks[0].name }] : []),
    ...(m.number_of_episodes ? [{ label: "Episodes", value: String(m.number_of_episodes) }] : []),
    ...(runtime ? [{ label: "Episode length", value: formatRuntime(runtime) }] : []),
    ...(language ? [{ label: "Language", value: language }] : []),
    ...(countries.length
      ? [{
          label: countries.length > 1 ? "Countries" : "Country",
          // Two at most on the pill; the rest are in the tooltip.
          value: countries.slice(0, 2).join(", ") + (countries.length > 2 ? ` +${countries.length - 2}` : ""),
          title: countries.join(", "),
        }]
      : []),
  ];

  return (
    <article className="space-y-10 pb-12">
      <header className="relative">
        <DetailBackdrop path={m.backdrop_path}>
          {/* The picture fades into the page from the bottom, as on a movie page. */}
          <div className="absolute inset-0 bg-gradient-to-t from-background from-0% via-background/55 via-35% to-transparent to-75%" />
          {/* Trailer button on larger screens: the top right corner of the picture. (On a phone it sits just above the
              title instead: see below.) */}
          {trailer && (
            <div className="absolute right-4 top-4 z-10 hidden md:block">
              <TrailerButton youtubeKey={trailer.key} label="Watch trailer" />
            </div>
          )}
        </DetailBackdrop>
        <div className="px-4 md:px-10 -mt-16 md:-mt-32 relative">
          <div className="flex flex-row items-center md:items-start gap-4 md:gap-8">
            <DetailPoster path={m.poster_path} alt={m.name ?? ""} layout="tv" />
            <div className="min-w-0 flex-1 space-y-2 md:space-y-3 md:pt-12">
              <div className="relative">
                {/* Trailer button on a phone: always the same distance above the title (see the movie page). */}
                {trailer && (
                  <div className="absolute right-0 bottom-full z-10 mb-[25px] md:hidden">
                    <TrailerButton youtubeKey={trailer.key} label="Watch trailer" />
                  </div>
                )}
                <h1 className="text-xl md:text-5xl font-bold tracking-tight break-words leading-tight">{m.name}</h1>
              </div>
              {m.tagline && <p className="text-sm md:text-base text-muted-foreground italic">{m.tagline}</p>}
              <div className="flex flex-wrap gap-x-3 gap-y-1.5 text-xs md:text-sm text-muted-foreground">
                {(() => {
                  const au = getAuCertification(m);
                  return au ? <AuRatingBadge rating={au} /> : null;
                })()}
                {years && <span className="inline-flex items-center gap-1.5"><Calendar className="size-3.5 md:size-4" />{years}</span>}
                {m.number_of_seasons ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Tv className="size-3.5 md:size-4" />
                    {m.number_of_seasons} season{m.number_of_seasons === 1 ? "" : "s"}
                  </span>
                ) : null}
              </div>
              {creators.length > 0 && (
                <p className="text-xs md:text-sm text-muted-foreground">
                  Created by{" "}
                  {creators.map((c, i) => (
                    <span key={c.id}>
                      {i > 0 && ", "}
                      <Link to="/person/$id" params={{ id: String(c.id) }} className="font-medium text-foreground hover:text-primary hover:underline">
                        {c.name}
                      </Link>
                    </span>
                  ))}
                </p>
              )}
              {airing && (
                <p className={`flex items-center gap-1.5 text-xs md:text-sm ${AIRING_TEXT[airing.tone]}`}>
                  <CalendarClock className={`size-3.5 md:size-4 shrink-0 ${airing.tone === "upcoming" ? "text-primary" : ""}`} />
                  {airing.text}
                </p>
              )}
            </div>
          </div>

          <div className="mt-4 md:mt-6 space-y-4 md:space-y-6">
            {m.genres && (
              <div className="flex flex-wrap gap-2">
                {m.genres.map((g) => (
                  <span key={g.id} className="text-xs rounded-full bg-surface border border-border px-3 py-1">{g.name}</span>
                ))}
              </div>
            )}
            <RatingsBar imdbId={imdbId} mediaType="tv" tmdbScore={m.vote_average} tmdbVotes={m.vote_count} />
            <MovieActionBar
              mediaType="tv"
              tmdbId={m.id}
              title={m.name || "Untitled"}
              posterPath={m.poster_path}
              backdropPath={m.backdrop_path}
              releaseDate={m.first_air_date}
              airing={!!m.next_episode_to_air || ["Returning Series", "In Production", "Planned"].includes(m.status ?? "")}
              imdbId={imdbId}
              homepage={m.homepage}
              reviews={m.reviews?.results}
            />
          </div>
        </div>
      </header>

      <section className="px-4 md:px-10 max-w-4xl">
        <h2 className="text-lg font-semibold mb-2">Overview</h2>
        <p className="text-muted-foreground leading-relaxed">{m.overview || "No overview available."}</p>
      </section>

      {/* Straight after the overview: a show's seasons are what you come to it for. */}
      {m.seasons && m.seasons.length > 0 && <SeasonList tvId={m.id} seasons={m.seasons} />}

      <WhatPeopleSay imdbId={imdbId} mediaType="tv" />

      <WatchProviders mediaType="tv" tmdbId={m.id} />

      <ParentsGuide imdbId={imdbId} />

      {m.credits?.cast && m.credits.cast.length > 0 && (
        <div className="px-4 md:px-10">
          <div className="mb-3 flex items-end justify-between gap-3">
            <h2 className="text-lg md:text-xl font-semibold">Top cast</h2>
            {/* Always: the row only has the latest season's regulars; the full page has everyone from every season. */}
            <SeeAllCast type="tv" id={m.id} />
          </div>
          <div className="flex gap-3 overflow-x-auto scrollbar-none -mx-4 px-4 md:-mx-10 md:px-10 pb-1">
            {m.credits.cast.slice(0, 20).map((c) => (
              <Link key={c.id} to="/person/$id" params={{ id: String(c.id) }} className="w-28 shrink-0 group" onClick={(e) => markHeroPoster(e.currentTarget)}>
                <div data-hero={`person:${c.id}`} className="aspect-[2/3] rounded-xl overflow-hidden bg-surface ring-1 ring-border">
                  {c.profile_path ? <img src={img(c.profile_path, "w185")!} alt={c.name} loading="lazy" className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" /> : <div className="w-full h-full grid place-items-center text-xs text-muted-foreground">No photo</div>}
                </div>
                <p className="mt-2 text-xs font-medium line-clamp-1">{c.name}</p>
                <p className="text-xs text-muted-foreground line-clamp-1">{c.character}</p>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Look-it-up figures, kept low on the page, in the same pills as a movie's. Only the ones TMDB knows are shown. */}
      {(network || details.length > 0) && (
        <section className="px-4 md:px-10">
          <h2 className="text-lg md:text-xl font-semibold mb-3">Details</h2>
          <div className="flex flex-wrap gap-3">
            {network && (
              // On a light plate in its own colours, like a movie's studio logo (TMDB's logos are made for a light page).
              <div
                className="grid min-h-[3.75rem] min-w-[7rem] place-items-center rounded-xl bg-white/90 px-4 py-2"
                title={network.name}
              >
                <img
                  src={img(network.logo_path, "w154")!}
                  srcSet={`${img(network.logo_path, "w154")} 1x, ${img(network.logo_path, "w300")} 2x`}
                  alt={network.name}
                  loading="lazy"
                  decoding="async"
                  className="h-8 w-auto max-w-[6rem] object-contain"
                />
              </div>
            )}
            {details.map((d) => (
              <div key={d.label} className="rounded-xl bg-surface border border-border px-4 py-2.5 min-w-[7rem]" title={d.title}>
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{d.label}</p>
                <p className="text-base font-semibold">{d.value}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {m.recommendations?.results && m.recommendations.results.length > 0 && (
        <div className="px-4 md:px-10">
          <MediaRail title="You might also like" items={m.recommendations.results.slice(0, 20).map((r) => ({ ...r, media_type: "tv" }))} />
        </div>
      )}
    </article>
  );
}
