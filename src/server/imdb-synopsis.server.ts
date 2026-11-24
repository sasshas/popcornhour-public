import { getCachedEntry, setCachedMany } from "./tmdb-cache.server.ts";
import type { WikiPlot, WikiPlotBlock } from "./wiki-plot.server.ts";

/**
 * A movie's synopsis from IMDb: the long, often scene-by-scene account its users write (the "Synopsis" part of a
 * title's Plot page), for the "Full plot" popup. Read from IMDb's own web API, as the Parents guide and the
 * distributor are. Many smaller or newer films have none.
 */

const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000; // a synopsis is often written some weeks after release

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === "#"
      ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
      : (ENTITIES[e.toLowerCase()] ?? m),
  );

/**
 * The synopsis as paragraphs. IMDb's plain text has no paragraph breaks, so they are taken from its HTML version
 * (`<br/>` between them) when it has them; a long text that still comes out as one block is cut into paragraphs of
 * a few sentences, so it is readable on a phone.
 */
export function paragraphs(html: string | undefined, plain: string): string[] {
  let parts = html
    ? html
        .split(/(?:<br\s*\/?>\s*)+|<\/p>\s*<p[^>]*>/i)
        .map((p) => decode(p.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim())
        .filter(Boolean)
    : [];
  if (parts.length <= 1) parts = plain.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 1 && parts[0].split(/\s+/).length > 150) {
    const sentences = parts[0].split(/(?<=[.!?]["”’)]?)\s+(?=["“(]?[A-Z0-9])/);
    parts = [];
    let cur = "";
    for (const s of sentences) {
      cur = cur ? `${cur} ${s}` : s;
      if (cur.split(/\s+/).length >= 80) {
        parts.push(cur);
        cur = "";
      }
    }
    if (cur) parts.push(cur);
  }
  return parts;
}

/** The synopsis as paragraphs, or null when the film has none. Same shape as the Wikipedia plot. */
export async function getImdbSynopsis(imdbId: string): Promise<WikiPlot | null> {
  const key = `imdbsynopsis:movie:${imdbId}`;
  const hit = getCachedEntry<WikiPlot | null>(key);
  if (hit && Date.now() - hit.fetchedAt < (hit.value ? TTL_MS : MISS_TTL_MS)) return hit.value;
  let plot: WikiPlot | null = null;
  try {
    const query = `query($id:ID!){title(id:$id){titleText{text} plots(first:5,filter:{type:SYNOPSIS}){edges{node{plotText{plainText plaidHtml}}}}}}`;
    const res = await fetch("https://caching.graphql.imdb.com/", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0", "x-imdb-client-name": "imdb-web-next" },
      body: JSON.stringify({ query, variables: { id: imdbId } }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return hit?.value ?? null;
    const json = (await res.json()) as {
      data?: { title?: {
        titleText?: { text?: string };
        plots?: { edges?: { node?: { plotText?: { plainText?: string; plaidHtml?: string } } }[] };
      } };
    };
    const title = json.data?.title;
    if (!title) return hit?.value ?? null; // an error answer, not "no synopsis"
    // Usually one; when there are several, the longest is the fullest.
    const best = (title.plots?.edges ?? [])
      .map((e) => e.node?.plotText)
      .filter((t) => t?.plainText?.trim())
      .sort((a, b) => (b!.plainText!.length - a!.plainText!.length))[0];
    const blocks: WikiPlotBlock[] = best ? paragraphs(best.plaidHtml, best.plainText!).map((p) => ({ kind: "p", text: p })) : [];
    plot = blocks.length
      ? { article: title.titleText?.text ?? "IMDb", url: `https://www.imdb.com/title/${imdbId}/plotsummary/#synopsis`, blocks }
      : null;
  } catch {
    return hit?.value ?? null;
  }
  setCachedMany([[key, plot]]);
  return plot;
}
