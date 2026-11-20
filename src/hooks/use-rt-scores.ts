import { useQueries } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo } from "react";
import { getPosterScores } from "@/lib/tmdb.functions";

export type RtItem = { mediaType: "movie" | "tv"; tmdbId: number };

// The server takes at most 100 titles per call; 60 keeps each call quick.
const CHUNK = 60;

type RtRow = NonNullable<Awaited<ReturnType<typeof getPosterScores>>>[number];
/**
 * Joins the chunks' answers. A fixed function passed as `combine`, so React Query hands back the same array until an
 * answer changes; otherwise the lookup below was rebuilt, and the Library / list sorted by it again, on every redraw.
 */
function joinChunks(results: { data?: RtRow[] | null }[]) {
  return results.flatMap((r) => r.data ?? []);
}

/**
 * Rotten Tomatoes critics' scores (the % on the posters) for a set of titles, for the "Rotten Tomatoes" sort.
 * Asked for only while `enabled` (that sort is chosen). It is the same lookup the posters make: a saved score is
 * used when there is one, and anything new counts towards the server's daily MDBList allowance, which stops on its
 * own when used up. Returns the score for a title, or null when none is known (yet).
 */
export function useRtScores(items: RtItem[], enabled: boolean) {
  const fetchScores = useServerFn(getPosterScores);
  const chunks = useMemo(() => {
    if (!enabled) return [];
    const keys = [...new Set(items.map((i) => `${i.mediaType}:${i.tmdbId}`))].sort();
    const out: RtItem[][] = [];
    for (let i = 0; i < keys.length; i += CHUNK) {
      out.push(
        keys.slice(i, i + CHUNK).map((k) => {
          const [mediaType, id] = k.split(":");
          return { mediaType: mediaType as "movie" | "tv", tmdbId: Number(id) };
        }),
      );
    }
    return out;
  }, [items, enabled]);
  const data = useQueries({
    queries: chunks.map((chunk) => ({
      queryKey: ["rt-scores", chunk.map((i) => `${i.mediaType}:${i.tmdbId}`).join(",")],
      queryFn: () => fetchScores({ data: { items: chunk } }),
      staleTime: 1000 * 60 * 60,
    })),
    combine: joinChunks,
  });
  return useMemo(() => {
    const m = new Map<string, number>();
    for (const s of data) if (s.rt !== null) m.set(`${s.mediaType}:${s.tmdbId}`, s.rt);
    return (mediaType: string, tmdbId: number): number | null => m.get(`${mediaType}:${tmdbId}`) ?? null;
  }, [data]);
}
