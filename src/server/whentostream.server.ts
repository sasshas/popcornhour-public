// Reads the monthly release calendars on whentostream.com (the "Streaming" and "In Theaters" pages) and each
// movie's own page there. The site is plain server-rendered WordPress with no API, so this reads its HTML.
//
// Kept polite: one request at a time per small batch, results kept in memory (a month for a few hours, a movie
// page for half a day), and nothing is fetched until someone opens that month. robots.txt allows these pages.
// If the site changes its layout the parser finds nothing and the Calendar falls back to TMDB's dates.

const BASE = "https://whentostream.com";
const UA = "Popcornhour/1.0 (personal calendar)";

export type WtsKind = "streaming" | "theatrical";

export type WtsDetails = {
  title: string;
  year: number | null;
  rating: string | null;
  runtime: string | null;
  theaterDate: string | null; // YYYY-MM-DD
  genres: string | null;
  director: string | null;
  cast: string | null;
  distributor: string | null;
  synopsis: string | null;
  vodDate: string | null;
  svodDate: string | null;
  svodPlatform: string | null;
  vodPlatform: string | null;
};

export type WtsEntry = {
  day: string; // YYYY-MM-DD: the date heading the movie sits under
  slug: string;
  poster: string | null;
  details: WtsDetails | null;
};

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

const decode = (s: string) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&hellip;/g, "…").replace(/&nbsp;/g, " ");

const clean = (s: string) => decode(s).replace(/\s+/g, " ").trim();

/** "November 1, 2026" -> "2026-11-01" (null if it is not a date). */
function parseDate(text: string): string | null {
  const m = /([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})/.exec(text);
  if (!m) return null;
  const mi = MONTHS.indexOf(m[1].toLowerCase());
  if (mi < 0) return null;
  return `${m[3]}-${String(mi + 1).padStart(2, "0")}-${String(Number(m[2])).padStart(2, "0")}`;
}

/** Fetches a page; null for anything but a plain 200 (an old month redirects to another site: treat as missing). */
async function getHtml(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status !== 200) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/** Runs fn over items, at most `limit` at a time. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/** Title-case a URL slug ("a-dogs-perfect-christmas-2026" -> "A Dogs Perfect Christmas"), for when a page can't be read. */
export function titleFromSlug(slug: string): string {
  return slug
    .replace(/-(19|20)\d{2}$/, "")
    .split("-")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

export function parseDetails(html: string): WtsDetails | null {
  const h1 = /<h1 class="entry-title">([^<]*)<\/h1>/.exec(html);
  if (!h1) return null;
  const rawTitle = clean(h1[1]);
  const ty = /\s*\(((?:19|20)\d{2})\)\s*$/.exec(rawTitle);
  const title = ty ? rawTitle.slice(0, ty.index) : rawTitle;

  // Everything between the start of the article text and the "where to stream" widget: bold "Label:" then its value.
  const startAt = html.indexOf('<div class="entry-content">');
  const endAt = html.indexOf("data-jw-widget", startAt);
  const body = startAt >= 0 ? html.slice(startAt, endAt > startAt ? endAt : startAt + 20000) : "";
  const fields: Record<string, string> = {};
  // The value runs to the next bold label, line break or end of the paragraph. It can contain inline markup
  // (a synopsis with an <em>italic title</em> in it used to be cut off at the first tag), which is stripped.
  const re = /<strong>(?:<span[^>]*>)?\s*([^<]*?)\s*(?:<\/span>)?<\/strong>\s*:?\s*((?:(?!<strong>|<br\s*\/?>|<\/p>)[\s\S])*)/g;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    const label = clean(m[1]).replace(/:$/, "").toLowerCase();
    const value = clean(m[2].replace(/<[^>]*>/g, "")).replace(/^:\s*/, "");
    if (label && value && !(label in fields)) fields[label] = value;
  }

  // The rent/buy line is labelled "VOD", "PVOD" (premium VOD) or "TVOD" depending on the movie.
  const vodKey = Object.keys(fields).find((k) => /^(p|t)?vod.*date|^digital.*date/.test(k));
  const platformOf = (v: string | undefined) => (v ? (/\(([^)]+)\)/.exec(v)?.[1]?.trim() ?? null) : null);
  return {
    title,
    year: ty ? Number(ty[1]) : null,
    rating: fields["rating"] ?? null,
    runtime: fields["runtime"] ?? null,
    theaterDate: fields["theater date"] ? parseDate(fields["theater date"]) : null,
    genres: fields["genre"] ?? null,
    director: fields["director"] ?? null,
    cast: fields["cast"] ?? null,
    distributor: fields["distributor"] ?? null,
    synopsis: fields["synopsis"] ?? null,
    vodDate: vodKey ? parseDate(fields[vodKey]) : null,
    svodDate: fields["svod release date"] ? parseDate(fields["svod release date"]) : null,
    svodPlatform: platformOf(fields["svod release date"]),
    vodPlatform: platformOf(vodKey ? fields[vodKey] : undefined),
  };
}

/** The movies under each date heading of a month page. Null when the page is not that month's calendar. */
export function parseMonthPage(html: string, kind: WtsKind, year: number, month: number): Omit<WtsEntry, "details">[] | null {
  const h1 = /<h1 class="entry-title">([^<]*)<\/h1>/.exec(html);
  if (!h1) return null;
  const heading = clean(h1[1]).toLowerCase();
  const word = kind === "streaming" ? "streaming" : "in theaters";
  if (!heading.startsWith(word) || !heading.includes(MONTHS[month - 1]) || !heading.includes(String(year))) return null;

  // Walk the date headings in order; every poster link up to the next heading belongs to that date.
  const marks: { at: number; day: string }[] = [];
  const hre = /<h2 class="wp-block-heading">(.*?)<\/h2>/g;
  for (let m = hre.exec(html); m; m = hre.exec(html)) {
    // A heading can have markup inside ("December 18<strong>, 2026</strong>"), so strip tags before reading it.
    const text = clean(m[1].replace(/<[^>]*>/g, ""));
    const day = /^[A-Za-z]+\.? \d{1,2}(?:st|nd|rd|th)?,? \d{4}$/.test(text) ? parseDate(text) : null;
    if (day) marks.push({ at: m.index, day });
  }
  const entries: Omit<WtsEntry, "details">[] = [];
  const seen = new Set<string>();
  const fre = /<figure class="wp-block-image[^"]*"><a href="https:\/\/whentostream\.com\/([a-z0-9-]+)\/"[^>]*>\s*<img[^>]*?\ssrc="([^"]+)"[^>]*>/g;
  for (let m = fre.exec(html); m; m = fre.exec(html)) {
    let day: string | null = null;
    for (const mk of marks) if (mk.at < m.index) day = mk.day;
    if (!day || !day.startsWith(`${year}-${String(month).padStart(2, "0")}`)) continue;
    if (!/aspect-ratio:2\/3/.test(m[0]) && !/resize=640%2C960/.test(m[2])) continue; // only the poster tiles
    const id = `${day}|${m[1]}`;
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push({ day, slug: m[1], poster: decode(m[2]) });
  }
  return entries;
}

const detailCache = new Map<string, { at: number; details: WtsDetails | null }>();
const DETAIL_TTL = 1000 * 60 * 60 * 12;
const monthCache = new Map<string, { at: number; entries: WtsEntry[] | null }>();
const REFRESH_MIN_GAP = 1000 * 60;

async function getDetails(slug: string, force = false): Promise<WtsDetails | null> {
  const hit = detailCache.get(slug);
  if (!force && hit && Date.now() - hit.at < DETAIL_TTL) return hit.details;
  const html = await getHtml(`${BASE}/${slug}/`);
  const details = html ? parseDetails(html) : null;
  // A failed read is only remembered briefly, so a hiccup does not hide a movie for half a day.
  detailCache.set(slug, { at: details ? Date.now() : Date.now() - DETAIL_TTL + 1000 * 60 * 5, details });
  if (detailCache.size > 3000) detailCache.delete(detailCache.keys().next().value!);
  return details;
}

/**
 * A month of whentostream's calendar, with each movie's own page read as well (rating, platform, cast...).
 * Null when the site has no calendar for that month (it only keeps recent and upcoming ones).
 */
export async function getWtsMonth(kind: WtsKind, year: number, month: number, refresh = false): Promise<WtsEntry[] | null> {
  const key = `${kind}|${year}-${month}`;
  const hit = monthCache.get(key);
  const isPast = Date.UTC(year, month, 1) < Date.now() - 1000 * 60 * 60 * 24 * 7;
  const ttl = isPast ? 1000 * 60 * 60 * 24 : 1000 * 60 * 60 * 3;
  // "Refresh" re-reads the site, but not more than once a minute per month (it is ~70 page reads).
  const wantFresh = refresh && (!hit || Date.now() - hit.at > REFRESH_MIN_GAP);
  if (hit && !wantFresh && Date.now() - hit.at < ttl) return hit.entries;

  const slugPath = `${kind === "streaming" ? "streaming" : "in-theaters"}-${MONTHS[month - 1]}-${year}`;
  const html = await getHtml(`${BASE}/${slugPath}/`);
  const listed = html ? parseMonthPage(html, kind, year, month) : null;
  let entries: WtsEntry[] | null = null;
  if (listed && listed.length > 0) {
    const detailBySlug = new Map<string, WtsDetails | null>();
    const slugs = [...new Set(listed.map((e) => e.slug))];
    await mapLimit(slugs, 6, async (slug) => {
      detailBySlug.set(slug, await getDetails(slug, wantFresh));
    });
    entries = listed.map((e) => ({ ...e, details: detailBySlug.get(e.slug) ?? null }));
  }
  // An empty or missing month is remembered for a short while only.
  monthCache.set(key, { at: entries ? Date.now() : Date.now() - ttl + 1000 * 60 * 10, entries });
  if (monthCache.size > 40) monthCache.delete(monthCache.keys().next().value!);
  return entries;
}
