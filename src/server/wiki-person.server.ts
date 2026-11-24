import { getCachedEntry, setCachedMany } from "./tmdb-cache.server.ts";
import { findArticle } from "./wiki-plot.server.ts";

/**
 * A person's English Wikipedia article, for the Wikipedia button on their page. Found through the Wikidata item
 * TMDB records for them, so it is the right person even when several share a name.
 */

const TTL_MS = 30 * 24 * 60 * 60 * 1000; // articles rarely move
const MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000; // someone new may get an article

/**
 * The article's address, or null when the person has no English article. Kept a month (a miss a week). When
 * Wikidata can't be reached, the last answer is kept; with none, undefined, and nothing is stored.
 */
export async function getPersonWikiUrl(wikidataId: string): Promise<string | null | undefined> {
  const key = `wiki:person:${wikidataId}`;
  const hit = getCachedEntry<string | null>(key);
  if (hit && Date.now() - hit.fetchedAt < (hit.value ? TTL_MS : MISS_TTL_MS)) return hit.value;
  let url: string | null;
  try {
    url = (await findArticle(wikidataId))?.url ?? null;
  } catch {
    return hit ? hit.value : undefined;
  }
  setCachedMany([[key, url]]);
  return url;
}
