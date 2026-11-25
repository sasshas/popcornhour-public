import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getJustWatchLink } from "@/lib/tmdb.functions";
import { useRegion } from "@/hooks/use-region";

/**
 * Where a JustWatch button goes: the title's own JustWatch page in the streaming country chosen under "Where to
 * watch", found by its TMDB id (kept a month on the server). Until that answers, or when JustWatch has no page for
 * it, JustWatch's search for the name in that country (JustWatch spells the UK "uk", every other country its code).
 */
export function useJustWatchUrl({ mediaType, tmdbId, imdbId, title }: {
  mediaType: "movie" | "tv";
  tmdbId: number;
  imdbId: string | null;
  title: string;
}): string {
  const region = useRegion();
  const country = region ?? "US";
  const fetchLink = useServerFn(getJustWatchLink);
  const { data } = useQuery({
    queryKey: ["justwatch-link", mediaType, tmdbId, country],
    queryFn: () => fetchLink({ data: { mediaType, id: tmdbId, imdbId, titles: [title], country } }),
    enabled: !!region && !!title,
    staleTime: Infinity,
  });
  const jwCountry = country === "GB" ? "uk" : country.toLowerCase();
  return data ?? `https://www.justwatch.com/${jwCountry}/search?q=${encodeURIComponent(title)}`;
}
