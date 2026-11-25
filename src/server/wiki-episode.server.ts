import { getCachedEntry, setCachedMany } from "./tmdb-cache.server.ts";

/**
 * Where an episode's Wikipedia button goes. Well-known episodes have an English article of their own; most others
 * are covered by their season's article (which lists every episode with a summary), and failing that the show's.
 * All three are found through the Wikidata items TMDB records for the episode, season and show, so it is the right
 * article even when several share a name.
 */

export type EpisodeWiki = { url: string; kind: "episode" | "season" | "show" };

const TTL_MS = 30 * 24 * 60 * 60 * 1000; // an episode's own article rarely moves
const FALLBACK_TTL_MS = 3 * 24 * 60 * 60 * 1000; // a new episode or season may get its own article soon after airing
const HEADERS = { "User-Agent": "Popcornhour/1.0 (self-hosted movie tracker)", Accept: "application/json" };
const ITEM = /^Q\d+$/;

/** The English Wikipedia address of each item that has one, by item. One request for all of them. */
async function enwikiUrls(items: string[]): Promise<Map<string, string>> {
  const u = new URL("https://www.wikidata.org/w/api.php");
  u.search = new URLSearchParams({
    action: "wbgetentities", ids: items.join("|"), props: "sitelinks/urls", sitefilter: "enwiki", format: "json",
  }).toString();
  const res = await fetch(u, { headers: HEADERS, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from wikidata.org`);
  const r = (await res.json()) as { entities?: Record<string, { sitelinks?: { enwiki?: { url?: string } } }> };
  const out = new Map<string, string>();
  for (const [id, e] of Object.entries(r.entities ?? {})) if (e.sitelinks?.enwiki?.url) out.set(id, e.sitelinks.enwiki.url);
  return out;
}

/**
 * The episode's article, else its season's (at the episode list), else the show's; null when none has one.
 * `wikidataIds` gives the episode's, season's and show's Wikidata items, in that order, and is only asked when the
 * kept answer is too old. An episode's own article is kept a month, anything else three days. When TMDB or Wikidata
 * can't be reached the last answer is kept; with none, undefined, and nothing is stored.
 */
export async function getEpisodeWikiLink(
  showId: number,
  season: number,
  episode: number,
  wikidataIds: () => Promise<(string | null | undefined)[]>,
): Promise<EpisodeWiki | null | undefined> {
  const key = `wiki:episode:${showId}:${season}:${episode}`;
  const hit = getCachedEntry<EpisodeWiki | null>(key);
  if (hit && Date.now() - hit.fetchedAt < (hit.value?.kind === "episode" ? TTL_MS : FALLBACK_TTL_MS)) return hit.value;
  let link: EpisodeWiki | null = null;
  try {
    const [ep, sn, show] = (await wikidataIds()).map((q) => (q && ITEM.test(q) ? q : null));
    const items = [ep, sn, show].filter((q): q is string => !!q);
    const urls = items.length ? await enwikiUrls(items) : new Map<string, string>();
    if (ep && urls.has(ep)) link = { url: urls.get(ep)!, kind: "episode" };
    else if (sn && urls.has(sn)) link = { url: `${urls.get(sn)}#Episodes`, kind: "season" };
    else if (show && urls.has(show)) link = { url: urls.get(show)!, kind: "show" };
  } catch {
    return hit ? hit.value : undefined;
  }
  setCachedMany([[key, link]]);
  return link;
}
