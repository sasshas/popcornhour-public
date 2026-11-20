import { getCachedEntry, setCachedMany } from "./tmdb-cache.server.ts";
import { logError } from "./redact.server.ts";

// Rotten Tomatoes scores from MDBList (https://mdblist.com, free key, optional: set MDBLIST_API_KEY).
// OMDb has no Rotten Tomatoes entry for many recent releases, and gives no audience score at all, so
// MDBList supplies the critics' score with its review count (for the Certified Fresh rule) and the
// audience score ("Popcornmeter"). Answers are cached in SQLite and re-checked on a schedule that
// depends on how new the title is, because a new release's scores appear and move in its first weeks.

export type MdblistKind = "movie" | "show";

/**
 * What we keep per title. Scores are percentages (0-100) or null when MDBList has none.
 * `v` is the layout of this object: cached entries without it (older versions) are fetched again.
 */
export type MdblistAnswer = {
  v: 2;
  /** Tomatometer: share of critics' reviews that are positive. */
  rt: number | null;
  /** How many critic reviews the Tomatometer is based on. */
  rtReviews: number | null;
  /** Popcornmeter: share of audience ratings that are positive. */
  audience: number | null;
  audienceVotes: number | null;
  released: string | null;
  /** The title's page on rottentomatoes.com, e.g. "/m/forgotten_island". Missing on entries cached before it existed. */
  rtPath?: string | null;
};

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * How long a cached answer is trusted before MDBList is asked again.
 * A score that exists is re-read often for a brand-new release (it keeps moving as reviews arrive) and
 * rarely for an old one; "no score yet" is retried quickly for new titles and slowly for old ones.
 * An unknown or future release date counts as brand new.
 */
export function mdblistTtlMs(released: string | null, hasScore: boolean, now = Date.now()): number {
  const t = released ? Date.parse(released) : NaN;
  const ageDays = Number.isNaN(t) ? 0 : (now - t) / DAY;
  if (hasScore) return ageDays <= 14 ? 6 * HOUR : ageDays <= 90 ? DAY : ageDays <= 365 ? 7 * DAY : 30 * DAY;
  return ageDays <= 90 ? 12 * HOUR : 7 * DAY;
}

const EMPTY: MdblistAnswer = {
  v: 2, rt: null, rtReviews: null, audience: null, audienceVotes: null, released: null, rtPath: null,
};

/** Only a plain rottentomatoes.com movie/show path is trusted ("/m/the_matrix", "/tv/primal"); anything else is dropped. */
export function safeRtPath(x: unknown): string | null {
  return typeof x === "string" && /^\/(m|tv)\/[A-Za-z0-9_-]+(\/s\d{2})?$/.test(x) ? x : null;
}

const pct = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? Math.round(x) : null);
const count = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? Math.round(x) : null);

/** Pull the Tomatometer, Popcornmeter and release date out of an MDBList title response. */
export function parseMdblist(json: unknown): MdblistAnswer {
  const j = (json ?? {}) as { released?: unknown; ratings?: { source?: unknown; value?: unknown; votes?: unknown; url?: unknown }[] };
  const find = (source: string) => (Array.isArray(j.ratings) ? j.ratings.find((r) => r?.source === source) : undefined);
  const tomatoes = find("tomatoes");
  const popcorn = find("popcorn");
  return {
    v: 2,
    rt: pct(tomatoes?.value),
    // A review count only means something next to a score.
    rtReviews: pct(tomatoes?.value) === null ? null : count(tomatoes?.votes),
    audience: pct(popcorn?.value),
    audienceVotes: pct(popcorn?.value) === null ? null : count(popcorn?.votes),
    released: typeof j.released === "string" ? j.released : null,
    rtPath: safeRtPath(tomatoes?.url),
  };
}

/** One live lookup by IMDb id. null = the lookup failed (do not cache); a title MDBList doesn't know is "no scores". */
export async function fetchMdblist(imdbId: string, kind: MdblistKind): Promise<MdblistAnswer | null> {
  const key = process.env.MDBLIST_API_KEY;
  if (!key) return null;
  try {
    // The key travels in the URL, so this URL is never logged (and redactText would scrub it anyway).
    const res = await fetch(`https://api.mdblist.com/imdb/${kind}/${imdbId}?apikey=${encodeURIComponent(key)}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 404) return { ...EMPTY };
    if (!res.ok) {
      logError("[mdblist] lookup failed", `HTTP ${res.status}`);
      return null;
    }
    return parseMdblist(await res.json());
  } catch (e) {
    logError("[mdblist] lookup failed", e);
    return null;
  }
}

// ---- Scores for the pill on posters -------------------------------------------------------------
// Posters only know a title's TMDB id, so these lookups go by TMDB id. One answer carries both the
// Tomatometer and the IMDb rating (the pill's fallback), and is saved under "pscore:<movie|tv>:<tmdb id>".
// It is re-checked on the same schedule as the title pages (mdblistTtlMs): often while a release is new
// and its score is still moving, rarely once it has settled.

/** What the poster pill needs. `v` is the layout of this object, as for MdblistAnswer. */
export type PosterScore = {
  v: 1;
  rt: number | null;
  rtReviews: number | null;
  /** IMDb rating out of 10, e.g. 7.3. */
  imdb: number | null;
  released: string | null;
};

// The free MDBList key allows 1,000 lookups a day. Posters may use most of it, leaving the rest for the
// title pages. Counted in memory: a restart starts the count again, which only errs towards more lookups.
const POSTER_DAILY_BUDGET = 800;
let budget = { day: "", used: 0 };
let pausedUntil = 0; // set when MDBList says the limit is reached

function takeBudget(now: number): boolean {
  if (now < pausedUntil) return false;
  const day = new Date(now).toISOString().slice(0, 10);
  if (budget.day !== day) budget = { day, used: 0 };
  if (budget.used >= POSTER_DAILY_BUDGET) return false;
  budget.used++;
  return true;
}

type TmdbLookup = { score: PosterScore; imdbId: string | null; full: MdblistAnswer };

/** One live lookup by TMDB id. null = the lookup failed (do not cache). */
async function fetchPosterScore(tmdbId: number, kind: MdblistKind): Promise<TmdbLookup | null> {
  const key = process.env.MDBLIST_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(`https://api.mdblist.com/tmdb/${kind}/${tmdbId}?apikey=${encodeURIComponent(key)}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 404) {
      return { score: { v: 1, rt: null, rtReviews: null, imdb: null, released: null }, imdbId: null, full: { ...EMPTY } };
    }
    if (res.status === 429) {
      pausedUntil = Date.now() + HOUR; // the daily limit is used up: stop asking for a while
      return null;
    }
    if (!res.ok) {
      logError("[mdblist] poster lookup failed", `HTTP ${res.status}`);
      return null;
    }
    const json = (await res.json()) as { ids?: { imdb?: unknown }; ratings?: { source?: unknown; value?: unknown }[] };
    const full = parseMdblist(json);
    const imdbValue = Array.isArray(json.ratings) ? json.ratings.find((r) => r?.source === "imdb")?.value : null;
    const imdb = typeof imdbValue === "number" && Number.isFinite(imdbValue) && imdbValue > 0 ? Math.round(imdbValue * 10) / 10 : null;
    const imdbId = typeof json.ids?.imdb === "string" && /^tt\d+$/.test(json.ids.imdb) ? json.ids.imdb : null;
    return { score: { v: 1, rt: full.rt, rtReviews: full.rtReviews, imdb, released: full.released }, imdbId, full };
  } catch (e) {
    logError("[mdblist] poster lookup failed", e);
    return null;
  }
}

/**
 * The poster pill's scores for one title: a fresh saved answer, else one MDBList lookup (saved), else the
 * old saved answer, else null (nothing known yet: the pill stays empty and a later visit tries again).
 */
export async function getPosterScore(
  mediaType: "movie" | "tv",
  tmdbId: number,
  now = Date.now(),
): Promise<PosterScore | null> {
  const cacheKey = `pscore:${mediaType}:${tmdbId}`;
  const entry = getCachedEntry<PosterScore>(cacheKey);
  const hit = entry && entry.value?.v === 1 ? entry : null;
  if (hit && now - hit.fetchedAt <= mdblistTtlMs(hit.value.released, hit.value.rt !== null, now)) return hit.value;
  if (!takeBudget(now)) return hit ? hit.value : null;

  const kind: MdblistKind = mediaType === "tv" ? "show" : "movie";
  const fresh = await fetchPosterScore(tmdbId, kind);
  if (!fresh) return hit ? hit.value : null;
  const entries: [string, unknown][] = [[cacheKey, fresh.score]];
  // The same answer is what the title's own page needs, so opening that page costs no second lookup.
  if (fresh.imdbId) entries.push([`mdb:${kind}:${fresh.imdbId}`, fresh.full]);
  setCachedMany(entries);
  return fresh.score;
}

/**
 * Critics' and audience scores for a title, or null when no key is configured or nothing could be
 * fetched or recalled. Fresh cache first; otherwise one MDBList lookup, which is then cached.
 * `fetcher` and `now` exist so tests can run without the network or a clock.
 */
export async function getMdblistScores(
  imdbId: string,
  kind: MdblistKind,
  fetcher: typeof fetchMdblist = fetchMdblist,
  now = Date.now(),
): Promise<MdblistAnswer | null> {
  if (!process.env.MDBLIST_API_KEY) return null;
  const cacheKey = `mdb:${kind}:${imdbId}`;

  const entry = getCachedEntry<MdblistAnswer>(cacheKey);
  const usable = entry && entry.value?.v === 2 ? entry : null; // entries without the layout marker are ignored
  // An entry saved before the Rotten Tomatoes page address was kept (rtPath missing, not just null) is
  // fetched again once, so the popup's "Open on Rotten Tomatoes" button shows up without waiting out the TTL.
  const hit = usable && usable.value.rtPath !== undefined ? usable : null;
  if (hit && now - hit.fetchedAt <= mdblistTtlMs(hit.value.released, hit.value.rt !== null, now)) {
    return hit.value;
  }

  const fresh = await fetcher(imdbId, kind);
  if (fresh) {
    setCachedMany([[cacheKey, fresh]]);
    return fresh;
  }
  // The lookup failed. A stale answer is better than none.
  return usable ? usable.value : null;
}
