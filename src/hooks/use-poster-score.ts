import { useQuery } from "@tanstack/react-query";
import { getPosterScores } from "@/lib/tmdb.functions";

/** Scores for a poster's pill. Both null = nothing known (yet). */
export type PosterScore = { rt: number | null; rtReviews: number | null; imdb: number | null };
type Kind = "movie" | "tv";
/** null = the server has no ratings key, so the pill falls back to the TMDB score. */
type Answer = PosterScore | null;

type Pending = { mediaType: Kind; tmdbId: number; resolve: (s: Answer) => void };

// Posters ask one at a time as they scroll into view; requests made within a few milliseconds of each
// other are sent to the server as one call (the same idea as use-provider-badges).
const BATCH_MS = 40;
const BATCH_MAX = 60;
const NOTHING: PosterScore = { rt: null, rtReviews: null, imdb: null };
let queue: Pending[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

async function flush() {
  timer = null;
  const batch = queue;
  queue = [];
  for (let i = 0; i < batch.length; i += BATCH_MAX) {
    const chunk = batch.slice(i, i + BATCH_MAX);
    try {
      const res = await getPosterScores({
        data: { items: chunk.map((r) => ({ mediaType: r.mediaType, tmdbId: r.tmdbId })) },
      });
      if (res === null) {
        for (const r of chunk) r.resolve(null);
        continue;
      }
      const byKey = new Map(res.map((r) => [`${r.mediaType}:${r.tmdbId}`, r]));
      for (const r of chunk) {
        const s = byKey.get(`${r.mediaType}:${r.tmdbId}`);
        r.resolve(s ? { rt: s.rt, rtReviews: s.rtReviews, imdb: s.imdb } : NOTHING);
      }
    } catch {
      for (const r of chunk) r.resolve(NOTHING); // the pill is decoration: never break a poster
    }
  }
}

function requestScore(mediaType: Kind, tmdbId: number): Promise<Answer> {
  return new Promise((resolve) => {
    queue.push({ mediaType, tmdbId, resolve });
    if (!timer) timer = setTimeout(flush, BATCH_MS);
  });
}

/**
 * Rotten Tomatoes and IMDb scores for one poster. Fetches only once `enabled` (the poster is in view).
 * `data` is undefined while loading, null when the server has no ratings key.
 */
export function usePosterScore(mediaType: string | undefined, tmdbId: number | string, enabled: boolean) {
  const id = Number(tmdbId);
  const kind: Kind | null = mediaType === "movie" || mediaType === "tv" ? mediaType : null;
  return useQuery({
    queryKey: ["poster-score", kind, id],
    queryFn: () => requestScore(kind!, id),
    enabled: enabled && !!kind && Number.isFinite(id) && id > 0,
    // The server decides how fresh a score must be (hours for a new release, weeks for an old one), so asking it
    // again each hour is cheap and picks up a moving score.
    staleTime: 1000 * 60 * 60,
  });
}
