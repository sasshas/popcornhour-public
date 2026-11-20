import { useQueries } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo } from "react";
import { getShowsLastAired } from "@/lib/tmdb.functions";

// Each new show takes a TMDB and a Trakt call on the server; 60 per call keeps each answer quick.
const CHUNK = 60;

type Row = Awaited<ReturnType<typeof getShowsLastAired>>[number];
/**
 * Joins the chunks' answers. A fixed function passed as `combine`, so React Query hands back the same array until an
 * answer changes; otherwise the lookup below was rebuilt, and the Library sorted by it again, on every redraw.
 */
function joinChunks(results: { data?: Row[] }[]) {
  return results.flatMap((r) => r.data ?? []);
}

/**
 * When each show's latest episode aired, for the Library's "Recently aired" sort. Asked for only while `enabled` (that
 * sort is chosen). Returns the time in milliseconds, or null when nothing has aired (or it is not looked up yet).
 */
export function useLastAired(ids: number[], enabled: boolean) {
  const fetchLastAired = useServerFn(getShowsLastAired);
  const chunks = useMemo(() => {
    if (!enabled) return [];
    const sorted = [...new Set(ids)].sort((a, b) => a - b);
    const out: number[][] = [];
    for (let i = 0; i < sorted.length; i += CHUNK) out.push(sorted.slice(i, i + CHUNK));
    return out;
  }, [ids, enabled]);
  const data = useQueries({
    queries: chunks.map((chunk) => ({
      queryKey: ["last-aired", chunk.join(",")],
      queryFn: () => fetchLastAired({ data: { ids: chunk } }),
      staleTime: 1000 * 60 * 30,
    })),
    combine: joinChunks,
  });
  return useMemo(() => {
    const m = new Map<number, number>();
    for (const r of data) {
      const t = r.lastAired ? Date.parse(r.lastAired) : NaN;
      if (!Number.isNaN(t)) m.set(r.tmdbId, t);
    }
    return (tmdbId: number): number | null => m.get(tmdbId) ?? null;
  }, [data]);
}
