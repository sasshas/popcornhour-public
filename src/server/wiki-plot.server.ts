import { getCachedEntry, setCachedMany } from "./tmdb-cache.server.ts";

/**
 * A movie's full plot from English Wikipedia, for the "Full plot" popup on a movie page.
 *
 * The article is found through Wikidata, which records each film's IMDb id (P345) and TMDB id (P4947), so it is the
 * right film even when several share a title. The article's "Plot" section is then read as plain text.
 * Wikipedia's text is CC BY-SA: the popup names the article and links to it.
 */

export type WikiPlotBlock = { kind: "p"; text: string } | { kind: "h"; text: string };
export type WikiPlot = { article: string; url: string; blocks: WikiPlotBlock[] };

const TTL_MS = 30 * 24 * 60 * 60 * 1000; // plots rarely change
const MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000; // new films often get a plot section in their first weeks
// Wikimedia asks automated clients to name themselves; kept generic on purpose.
const HEADERS = { "User-Agent": "Popcornhour/1.0 (self-hosted movie tracker)", Accept: "application/json" };
// Headings the plot goes under. "Plot" on nearly every film; the others on a few.
const PLOT_HEADING = /^(plot|plot summary|synopsis|story|storyline|summary)$/i;

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return (await res.json()) as T;
}

/** The Wikidata item for a film, by IMDb id first, then TMDB id. */
async function findItem(imdbId: string | null, tmdbId: number): Promise<string | null> {
  const statements = [imdbId ? `P345=${imdbId}` : null, `P4947=${tmdbId}`].filter(Boolean) as string[];
  for (const s of statements) {
    const u = new URL("https://www.wikidata.org/w/api.php");
    u.search = new URLSearchParams({
      action: "query", list: "search", srsearch: `haswbstatement:${s}`, srlimit: "1", format: "json",
    }).toString();
    const r = await getJson<{ query?: { search?: { title?: string }[] } }>(u.toString());
    const q = r.query?.search?.[0]?.title;
    if (q && /^Q\d+$/.test(q)) return q;
  }
  return null;
}

/** The English Wikipedia article linked to a Wikidata item. Also used for a person's Wikipedia button. */
export async function findArticle(item: string): Promise<{ title: string; url: string } | null> {
  const u = new URL("https://www.wikidata.org/w/api.php");
  u.search = new URLSearchParams({
    action: "wbgetentities", ids: item, props: "sitelinks/urls", sitefilter: "enwiki", format: "json",
  }).toString();
  const r = await getJson<{ entities?: Record<string, { sitelinks?: { enwiki?: { title?: string; url?: string } } }> }>(
    u.toString(),
  );
  const link = Object.values(r.entities ?? {})[0]?.sitelinks?.enwiki;
  return link?.title && link.url ? { title: link.title, url: link.url } : null;
}

/** The article's plot section as paragraphs (and any sub-headings), or null when it has none. */
async function readPlot(title: string): Promise<WikiPlotBlock[] | null> {
  const u = new URL("https://en.wikipedia.org/w/api.php");
  u.search = new URLSearchParams({
    action: "query", prop: "extracts", explaintext: "1", exsectionformat: "wiki", titles: title,
    redirects: "1", format: "json", formatversion: "2",
  }).toString();
  const r = await getJson<{ query?: { pages?: { extract?: string }[] } }>(u.toString());
  const text = r.query?.pages?.[0]?.extract;
  if (!text) return null;
  return plotBlocks(text);
}

/** Cuts the plot section out of an article's plain text ("== Plot ==" up to the next top-level heading). */
export function plotBlocks(article: string): WikiPlotBlock[] | null {
  const lines = article.split("\n");
  const start = lines.findIndex((l) => {
    const m = /^==\s*(.+?)\s*==$/.exec(l.trim());
    return !!m && !m[1].startsWith("=") && PLOT_HEADING.test(m[1]);
  });
  if (start < 0) return null;
  const blocks: WikiPlotBlock[] = [];
  for (const raw of lines.slice(start + 1)) {
    const line = raw.trim();
    if (/^==[^=]/.test(line)) break; // the next section
    if (!line) continue;
    const sub = /^={3,}\s*(.+?)\s*={3,}$/.exec(line);
    blocks.push(sub ? { kind: "h", text: sub[1] } : { kind: "p", text: line });
  }
  // A heading with nothing after it (an empty last sub-section) is dropped.
  while (blocks.length && blocks[blocks.length - 1].kind === "h") blocks.pop();
  return blocks.some((b) => b.kind === "p") ? blocks : null;
}

/**
 * The plot, kept a month (a film with none is checked again after a week). When Wikipedia can't be reached, the
 * last answer is kept; with none, null, and nothing is stored, so the next visit tries again.
 */
export async function getWikiPlot(tmdbId: number, imdbId: string | null): Promise<WikiPlot | null> {
  const key = `wikiplot:movie:${tmdbId}`;
  const hit = getCachedEntry<WikiPlot | null>(key);
  if (hit && Date.now() - hit.fetchedAt < (hit.value ? TTL_MS : MISS_TTL_MS)) return hit.value;
  let plot: WikiPlot | null = null;
  try {
    const item = await findItem(imdbId, tmdbId);
    const article = item ? await findArticle(item) : null;
    const blocks = article ? await readPlot(article.title) : null;
    plot = article && blocks ? { article: article.title, url: article.url, blocks } : null;
  } catch {
    return hit?.value ?? null;
  }
  setCachedMany([[key, plot]]);
  return plot;
}
