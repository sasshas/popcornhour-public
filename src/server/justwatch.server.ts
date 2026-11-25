import { getCachedEntry, setCachedMany } from "./tmdb-cache.server.ts";

/**
 * A movie's or show's own page on JustWatch, for the JustWatch button under "Where to watch" (and in Links).
 *
 * JustWatch has no address by IMDb or TMDB id, so its site's own search (the GraphQL API its pages use) is asked for
 * the title in the streaming country, and the result whose TMDB id (or IMDb id) matches is taken: the right title
 * even when several share a name. The answer is the page's path with its country, e.g. "/au/movie/inception".
 */

const TTL_MS = 30 * 24 * 60 * 60 * 1000; // a title's JustWatch page rarely moves
const MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000; // new titles get added
const HEADERS = { "User-Agent": "Popcornhour/1.0 (self-hosted movie tracker)", "Content-Type": "application/json" };

const QUERY = `query($country: Country!, $q: String!) {
  popularTitles(country: $country, first: 10, filter: { searchQuery: $q }) {
    edges { node { objectType content(country: $country, language: "en") { fullPath externalIds { imdbId tmdbId } } } }
  }
}`;

type Edge = {
  node?: { objectType?: string; content?: { fullPath?: string; externalIds?: { imdbId?: string | null; tmdbId?: string | null } } };
};

async function search(country: string, q: string): Promise<Edge[]> {
  const res = await fetch("https://apis.justwatch.com/graphql", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ query: QUERY, variables: { country, q } }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from JustWatch`);
  const r = (await res.json()) as { data?: { popularTitles?: { edges?: Edge[] } }; errors?: unknown[] };
  // A country JustWatch doesn't cover answers with an error, not a network failure: treated as "no page".
  return r.data?.popularTitles?.edges ?? [];
}

/**
 * The page's path, or null when JustWatch has no page for it in that country. Kept a month (a miss a week). When
 * JustWatch can't be reached, the last answer is kept; with none, undefined, and nothing is stored.
 */
export async function getJustWatchPath(
  mediaType: "movie" | "tv",
  tmdbId: number,
  imdbId: string | null,
  titles: string[],
  country: string,
): Promise<string | null | undefined> {
  const key = `jw:${country}:${mediaType}:${tmdbId}`;
  const hit = getCachedEntry<string | null>(key);
  if (hit && Date.now() - hit.fetchedAt < (hit.value ? TTL_MS : MISS_TTL_MS)) return hit.value;
  const type = mediaType === "tv" ? "SHOW" : "MOVIE";
  let path: string | null = null;
  try {
    // The title first, then the original title (a foreign film can be listed under either).
    for (const q of [...new Set(titles.filter(Boolean))]) {
      const edges = (await search(country, q)).filter((e) => e.node?.objectType === type);
      const match =
        edges.find((e) => e.node?.content?.externalIds?.tmdbId === String(tmdbId)) ??
        (imdbId ? edges.find((e) => e.node?.content?.externalIds?.imdbId === imdbId) : undefined);
      const p = match?.node?.content?.fullPath;
      if (p && /^\/[a-z]{2}\//.test(p)) {
        path = p;
        break;
      }
    }
  } catch {
    return hit ? hit.value : undefined;
  }
  setCachedMany([[key, path]]);
  return path;
}
