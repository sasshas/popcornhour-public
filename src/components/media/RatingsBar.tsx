import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { getOmdbRatings } from "@/lib/tmdb.functions";
import { tmdbPercent } from "@/lib/tmdb";
import { popcornIcon, tomatometerIcon } from "@/lib/rotten-tomatoes";
import { POPCORN_ICON, TOMATO_ICON } from "@/components/media/rt-icons";
import { RottenTomatoesDialog } from "@/components/media/RottenTomatoesDialog";
import metacriticLogo from "@/assets/ratings/metacritic.png";
import tmdbLogo from "@/assets/ratings/tmdb.png";

// A little tighter on a phone so more badges fit on one line.
const PILL = "inline-flex items-center gap-1.5 md:gap-2 rounded-xl bg-surface border border-border px-2 py-1.5 md:px-3 md:py-2";
// Every score icon sits in the same box (28px, 24px on a phone), so tall, wide and square artwork all line up.
const ICON = "size-6 md:size-7 shrink-0 object-contain";

export function RatingsBar({
  imdbId, mediaType = "movie", tmdbScore, tmdbVotes,
}: { imdbId?: string | null; mediaType?: "movie" | "tv"; tmdbScore?: number; tmdbVotes?: number }) {
  const fetchRatings = useServerFn(getOmdbRatings);
  const { data } = useQuery({
    queryKey: ["omdb", mediaType, imdbId],
    queryFn: () => fetchRatings({ data: { imdbId: imdbId!, mediaType } }),
    enabled: !!imdbId,
    staleTime: 1000 * 60 * 60 * 24,
  });
  const [rtOpen, setRtOpen] = useState(false);

  const critics = data?.criticsScore ?? null;
  const audience = data?.audienceScore ?? null;
  // The one Rotten Tomatoes badge shows the critics' score (or the audience's if that is all there is);
  // tapping it opens a popup with both.
  const rtIcon =
    critics !== null
      ? TOMATO_ICON[tomatometerIcon(critics, data?.criticsReviews, mediaType)]
      : audience !== null
        ? POPCORN_ICON[popcornIcon(audience, data?.audienceVotes)]
        : null;
  const rtValue = critics ?? audience;

  return (
    // The gap grows with the screen: tight on the narrowest phones (so four badges still fit one line), roomier on
    // typical and large ones.
    <div className="flex flex-wrap items-center gap-1.5 min-[375px]:max-md:gap-2 min-[400px]:max-md:gap-3 md:gap-2 text-sm">
      {typeof tmdbScore === "number" && tmdbScore > 0 && (
        <span className={PILL} title={tmdbVotes ? `TMDB user score, ${tmdbVotes.toLocaleString()} votes` : "TMDB user score"}>
          <img src={tmdbLogo} alt="TMDB" className={`${ICON} rounded-md`} />
          <span className="font-semibold text-foreground">{tmdbPercent(tmdbScore)}%</span>
        </span>
      )}
      {data?.imdb && (
        <span className={PILL}>
          <span className="text-[10px] font-bold bg-[#f5c518] text-black px-1.5 py-0.5 rounded">IMDb</span>
          <span className="font-semibold text-foreground">{data.imdb}</span>
        </span>
      )}
      {rtIcon && rtValue !== null && (
        <>
          <button
            type="button"
            onClick={() => setRtOpen(true)}
            aria-haspopup="dialog"
            title="Rotten Tomatoes: tap for the critics' and audience scores"
            className={`${PILL} cursor-pointer transition hover:border-primary/50 hover:bg-surface-elevated active:scale-[0.97]`}
          >
            <img src={rtIcon} alt="Rotten Tomatoes" className={ICON} />
            <span className="font-semibold text-foreground">{rtValue}%</span>
          </button>
          <RottenTomatoesDialog
            open={rtOpen}
            onOpenChange={setRtOpen}
            mediaType={mediaType}
            critics={critics !== null ? { score: critics, reviews: data?.criticsReviews ?? null } : null}
            audience={audience !== null ? { score: audience, ratings: data?.audienceVotes ?? null } : null}
            url={data?.rottenTomatoesUrl ?? null}
          />
        </>
      )}
      {data?.metascore && (
        <span className={PILL} title="Metacritic Metascore">
          <img src={metacriticLogo} alt="Metacritic" className={ICON} />
          <span className="font-semibold text-foreground">{data.metascore}</span>
        </span>
      )}
    </div>
  );
}
