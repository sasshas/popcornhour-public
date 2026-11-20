import { useQueries } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo } from "react";
import { getTmdbScores } from "@/lib/tmdb.functions";

export type ScoreItem = { mediaType: "movie" | "tv"; tmdbId: number };

type ScoreRow = Awaited<ReturnType<typeof getTmdbScores>>[number];
/**
 * Joins the chunks' answers. Passed to useQueries as `combine` and kept outside the hook (one fixed function): React
 * Query then hands back the same object until an answer actually changes. Without it every redraw got a new array,
 * so the score / date lookups below were rebuilt, and the lists sorted with them re-sorted, on every redraw.
 */
function joinChunks(results: { data?: ScoreRow[]; isPending: boolean }[]) {
  return { data: results.flatMap((r) => r.data ?? []), loading: results.some((r) => r.isPending) };
}

/** TMDB score, full release date and genres for each item, from one batched (and server-cached) lookup. */
export function useTmdbInfo(items: ScoreItem[]) {
  const fetchScores = useServerFn(getTmdbScores);
  const chunks = useMemo(() => {
    const out: ScoreItem[][] = [];
    for (let i = 0; i < items.length; i += 400) out.push(items.slice(i, i + 400));
    return out;
  }, [items]);
  // loading: true until every chunk has answered (the dates are then complete).
  const { data, loading } = useQueries({
    queries: chunks.map((chunk) => ({
      // "tmdb-scores3": answers cached in the browser before the release date and genres were added are not reused.
      queryKey: [
        "tmdb-scores3",
        chunk.map((i) => `${i.mediaType}:${i.tmdbId}`).sort().join(","),
      ],
      queryFn: () => fetchScores({ data: { items: chunk } }),
      staleTime: 1000 * 60 * 60,
    })),
    combine: joinChunks,
  });
  return useMemo(() => {
    const scores = new Map<string, number | null>();
    const dates = new Map<string, string | null>();
    const genres = new Map<string, string[]>();
    for (const s of data) {
      scores.set(`${s.mediaType}:${s.tmdbId}`, s.voteAverage);
      dates.set(`${s.mediaType}:${s.tmdbId}`, s.releaseDate ?? null);
      genres.set(`${s.mediaType}:${s.tmdbId}`, s.genres ?? []);
    }
    return {
      getScore: (mediaType: string | undefined, tmdbId: number | string): number | null =>
        scores.get(`${mediaType}:${tmdbId}`) ?? null,
      /** The full release date, or null when not known (yet). */
      getDate: (mediaType: string | undefined, tmdbId: number | string): string | null =>
        dates.get(`${mediaType}:${tmdbId}`) ?? null,
      /** TMDB genre names, or null when not looked up (yet). */
      getGenres: (mediaType: string | undefined, tmdbId: number | string): string[] | null =>
        genres.get(`${mediaType}:${tmdbId}`) ?? null,
      loading,
    };
  }, [data, loading]);
}

export function useTmdbScores(items: ScoreItem[]) {
  return useTmdbInfo(items).getScore;
}
