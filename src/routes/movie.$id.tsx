import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, queryOptions } from "@tanstack/react-query";
import { peekOf } from "@/lib/peek";
import { getDistributor, getMovie } from "@/lib/tmdb.functions";
import { MediaRail } from "@/components/media/MediaRail";
import { img, formatRuntime, type MovieDetails } from "@/lib/tmdb";
import { displayName, formatDateAULong } from "@/lib/utils";
import { Calendar, ChevronRight, Clapperboard, Clock } from "lucide-react";
import { AuRatingBadge, getAuCertification } from "@/components/media/AuRatingBadge";
import { MovieActionBar } from "@/components/media/MovieActionBar";
import { TrailerButton } from "@/components/media/TrailerButton";
import { WatchProviders } from "@/components/media/WatchProviders";
import { RatingsBar } from "@/components/media/RatingsBar";
import { WhatPeopleSay } from "@/components/media/WhatPeopleSay";
import { ParentsGuide } from "@/components/media/ParentsGuide";
import { DetailBackdrop, DetailPoster, DetailSkeleton } from "@/components/media/DetailHero";

const movieQuery = (id: number) =>
  queryOptions({ queryKey: ["movie", id], queryFn: () => getMovie({ data: { id } }), staleTime: 1000 * 60 * 30 });

export const Route = createFileRoute("/movie/$id")({
  // A page opened directly is drawn on the server, which waits for the details. A tap inside the app does not wait:
  // the page changes at once (so the page-change animation plays on the tap, with the placeholder if the details are
  // not here yet) and the details are fetched alongside. Returns whatever is already known.
  loader: ({ context, params }) => {
    const query = movieQuery(Number(params.id));
    if (typeof window === "undefined") return context.queryClient.ensureQueryData(query);
    void context.queryClient.prefetchQuery(query);
    return context.queryClient.getQueryData(query.queryKey);
  },
  head: ({ loaderData, params }) => ({
    meta: [
      // The name comes from the details, or from the card that was tapped while they are still loading.
      { title: `${loaderData?.title ?? peekOf("movie", params.id)?.title ?? "Movie"} — Popcornhour` },
      { name: "description", content: loaderData?.overview?.slice(0, 160) ?? "" },
      ...(loaderData?.backdrop_path ? [{ property: "og:image" as const, content: img(loaderData.backdrop_path, "w1280")! }] : []),
    ],
  }),
  component: MoviePage,
  // Only a fallback now: the loader above no longer waits, so the page itself shows the placeholder while its details
  // load. (It must not be set to appear at once: it would be drawn before the router starts the page-change animation,
  // and the tapped poster would have nothing to grow from.)
  pendingComponent: () => <DetailSkeleton layout="movie" />,
});

/**
 * Whether to stay through the credits, from TMDB's keywords (tagged from MediaStinger; Trakt gives the same answer).
 * Nobody tracks scenes before the credits, only during and after. A film with neither tag is only called "none"
 * once it is out and well known, since a missing tag on a small or new film more likely means nobody has checked.
 */
function creditsScenes(m: MovieDetails): { text: string; any: boolean } | null {
  const tags = new Set((m.keywords?.keywords ?? []).map((k) => k.name.toLowerCase()));
  const during = tags.has("duringcreditsstinger");
  const after = tags.has("aftercreditsstinger");
  // Kept short so it fits on one line beside the poster on a phone.
  if (during && after) return { text: "Mid & post-credits scenes", any: true };
  if (during) return { text: "Mid-credits scene", any: true };
  if (after) return { text: "Post-credits scene", any: true };
  const released = !!m.release_date && m.release_date <= new Date().toISOString().slice(0, 10);
  return released && (m.vote_count ?? 0) >= 300 ? { text: "No credits scenes", any: false } : null;
}

/** US dollars in short form: $1.5M, $38M, $1.7B. */
function formatMoney(n: number): string {
  const short = (v: number) => (v >= 100 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, ""));
  if (n >= 1e9) return `$${short(n / 1e9)}B`;
  if (n >= 1e6) return `$${short(n / 1e6)}M`;
  if (n >= 1e3) return `$${short(n / 1e3)}K`;
  return `$${n}`;
}

function MoviePage() {
  const { id } = Route.useParams();
  // The details: what the loader already had (a page drawn on the server, or one opened before), otherwise fetched
  // now, with the placeholder page shown meanwhile.
  const known = Route.useLoaderData();
  const { data: m, error } = useQuery({ ...movieQuery(Number(id)), ...(known ? { initialData: known } : {}) });
  // Who released it (from IMDb, as TMDB does not say). Looked up once the IMDb id is known.
  const imdbId = m?.imdb_id ?? null;
  const distributorQuery = useQuery({
    queryKey: ["distributor", imdbId],
    queryFn: () => getDistributor({ data: { imdbId: imdbId! } }),
    enabled: !!imdbId,
    staleTime: 1000 * 60 * 60 * 24,
  });
  if (!m && error) throw error; // shown by the app's error page
  if (!m) return <DetailSkeleton layout="movie" />;
  const trailer = m.videos?.results.find((v) => v.site === "YouTube" && v.type === "Trailer" && v.official) ?? m.videos?.results.find((v) => v.site === "YouTube" && v.type === "Trailer");
  // Director(s) from the credits that already come with the movie. (A film can have several; one person can be
  // listed twice, so keep each id once.)
  const directors = (m.credits?.crew ?? []).filter(
    (c, i, all) => c.job === "Director" && all.findIndex((o) => o.id === c.id && o.job === "Director") === i,
  );
  const credits = creditsScenes(m);
  // The logo in the Details row: the distributor's (Warner Bros., Universal, A24...), or, when it has no logo on
  // TMDB, the main studio's (the first one listed that has a logo). While the distributor is being looked up the
  // logo's place is held, so the row does not jump and the studio logo is not swapped out a moment later.
  const distributor = distributorQuery.data ?? null;
  const logoLoading = !!imdbId && distributorQuery.isPending;
  const studio = distributor?.company ?? (logoLoading ? null : m.production_companies?.find((c) => c.logo_path));
  // The look-it-up figures for the Details row, low on the page. Only what TMDB knows is listed.
  const language = m.original_language ? displayName("language", m.original_language) : null;
  const countries = (m.production_countries ?? []).map((c) => displayName("region", c.iso_3166_1) ?? c.name);
  const collection = m.belongs_to_collection;
  const details: { label: string; value: string; title?: string }[] = [
    // A distributor with no logo on TMDB still gets its name in the row.
    ...(distributor && !distributor.company ? [{ label: "Distributor", value: distributor.name }] : []),
    // Only while a movie is still on its way ("Post Production", "In Production", "Planned"...).
    ...(m.status && m.status !== "Released" ? [{ label: "Status", value: m.status }] : []),
    ...(m.budget ? [{ label: "Budget", value: formatMoney(m.budget), title: `$${m.budget.toLocaleString("en-US")}` }] : []),
    ...(m.revenue ? [{ label: "Revenue", value: formatMoney(m.revenue), title: `$${m.revenue.toLocaleString("en-US")}` }] : []),
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
          {/* The picture fades into the page from the bottom. It used to be nearly solid up to 40% of the way up; now it
              is lighter and clears sooner, so much more of the image shows. */}
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
            <DetailPoster path={m.poster_path} alt={m.title ?? ""} layout="movie" />
            <div className="min-w-0 flex-1 space-y-2 md:space-y-3 md:pt-12">
              <div className="relative">
                {/* Trailer button on a phone: always the same distance above the title, however many lines the title
                    takes. (The title block is centred beside the poster, so a one-line title sits lower than a
                    two-line one; a button pinned to the picture left a bigger gap above a short title.) */}
                {trailer && (
                  <div className="absolute right-0 bottom-full z-10 mb-[25px] md:hidden">
                    <TrailerButton youtubeKey={trailer.key} label="Watch trailer" />
                  </div>
                )}
                <h1 className="text-xl md:text-5xl font-bold tracking-tight break-words leading-tight">{m.title}</h1>
              </div>
              {m.tagline && <p className="text-sm md:text-base text-muted-foreground italic">{m.tagline}</p>}
              <div className="flex flex-wrap gap-x-3 gap-y-1.5 text-xs md:text-sm text-muted-foreground">
                {(() => {
                  const au = getAuCertification(m);
                  return au ? <AuRatingBadge rating={au} /> : null;
                })()}
                {m.release_date && <span className="inline-flex items-center gap-1.5"><Calendar className="size-3.5 md:size-4" />{formatDateAULong(m.release_date)}</span>}
                {m.runtime ? <span className="inline-flex items-center gap-1.5"><Clock className="size-3.5 md:size-4" />{formatRuntime(m.runtime)}</span> : null}
              </div>
              {directors.length > 0 && (
                <p className="text-xs md:text-sm text-muted-foreground">
                  Directed by{" "}
                  {directors.map((d, i) => (
                    <span key={d.id}>
                      {i > 0 && ", "}
                      <Link to="/person/$id" params={{ id: String(d.id) }} className="font-medium text-foreground hover:text-primary hover:underline">
                        {d.name}
                      </Link>
                    </span>
                  ))}
                </p>
              )}
              {credits && (
                <p className={`flex items-center gap-1.5 text-xs md:text-sm ${credits.any ? "font-medium text-foreground" : "text-muted-foreground"}`}>
                  <Clapperboard className={`size-3.5 md:size-4 shrink-0 ${credits.any ? "text-primary" : ""}`} />
                  {credits.text}
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
            <RatingsBar imdbId={m.imdb_id} mediaType="movie" tmdbScore={m.vote_average} tmdbVotes={m.vote_count} />
            <MovieActionBar
              tmdbId={m.id}
              title={m.title || "Untitled"}
              posterPath={m.poster_path}
              backdropPath={m.backdrop_path}
              releaseDate={m.release_date}
              imdbId={m.imdb_id}
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

      <WhatPeopleSay imdbId={m.imdb_id} />

      <WatchProviders mediaType="movie" tmdbId={m.id} />

      <ParentsGuide imdbId={m.imdb_id} />

      {m.credits?.cast && m.credits.cast.length > 0 && (
        <div className="px-4 md:px-10">
          <h2 className="text-lg md:text-xl font-semibold mb-3">Top cast</h2>
          <div className="flex gap-3 overflow-x-auto scrollbar-none -mx-4 px-4 md:-mx-10 md:px-10 pb-1">
            {m.credits.cast.slice(0, 20).map((c) => (
              <Link key={c.id} to="/person/$id" params={{ id: String(c.id) }} className="w-28 shrink-0 group">
                <div className="aspect-[2/3] rounded-xl overflow-hidden bg-surface ring-1 ring-border">
                  {c.profile_path ? (
                    <img src={img(c.profile_path, "w185")!} alt={c.name} loading="lazy" className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" />
                  ) : <div className="w-full h-full grid place-items-center text-xs text-muted-foreground">No photo</div>}
                </div>
                <p className="mt-2 text-xs font-medium line-clamp-1">{c.name}</p>
                <p className="text-xs text-muted-foreground line-clamp-1">{c.character}</p>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Look-it-up figures, kept low on the page. Only the ones TMDB knows are shown. */}
      {(studio || logoLoading || collection || details.length > 0) && (
        <section className="px-4 md:px-10">
          <h2 className="text-lg md:text-xl font-semibold mb-3">Details</h2>
          {/* Every pill in a row is the same height (the row stretches them), the studio logo included. */}
          <div className="flex flex-wrap gap-3">
            {/* The logo's place while the distributor is looked up: the same size as the logo plate, faint. */}
            {logoLoading && <div className="min-h-[3.75rem] min-w-[7rem] rounded-xl bg-white/10" aria-hidden />}
            {studio && (
              // Studio logos on TMDB come in any colour, many of them black and made for a light page, so the logo sits
              // on a light plate in its own colours. (Drawing it as a plain white shape was tried: a detailed logo such
              // as 20th Century Studios turned into a grey blob.) Tapping it opens the studio's other movies.
              <Link
                to="/studio/$id"
                params={{ id: String(studio.id) }}
                className="grid min-h-[3.75rem] min-w-[7rem] place-items-center rounded-xl bg-white/90 px-4 py-2 transition hover:bg-white active:scale-95"
                title={`More from ${studio.name}`}
                aria-label={`More movies from ${studio.name}`}
              >
                <img
                  src={img(studio.logo_path, "w154")!}
                  srcSet={`${img(studio.logo_path, "w154")} 1x, ${img(studio.logo_path, "w300")} 2x`}
                  alt={studio.name}
                  loading="lazy"
                  decoding="async"
                  className="h-8 w-auto max-w-[6rem] object-contain"
                />
              </Link>
            )}
            {collection && (
              // The film series. Tappable (it opens the series' movies), so it has an arrow and a coloured edge.
              <Link
                to="/collection/$id"
                params={{ id: String(collection.id) }}
                className="flex min-w-[7rem] items-center gap-2 rounded-xl border border-primary/40 bg-surface px-4 py-2.5 transition hover:border-primary active:scale-95"
                aria-label={`Open ${collection.name}`}
              >
                <span className="min-w-0">
                  <span className="block text-[11px] uppercase tracking-wide text-muted-foreground">Collection</span>
                  <span className="block text-base font-semibold">{collection.name.replace(/\s+Collection$/i, "")}</span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-primary" />
              </Link>
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
          <MediaRail title="You might also like" items={m.recommendations.results.slice(0, 20).map((r) => ({ ...r, media_type: "movie" }))} />
        </div>
      )}
    </article>
  );
}
