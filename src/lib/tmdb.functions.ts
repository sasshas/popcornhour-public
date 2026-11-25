import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireUser } from "@/lib/auth-middleware";
import type {
  MediaItem, MovieDetails, TVDetails, SeasonDetails, EpisodeDetails, PersonDetails,
} from "./tmdb";
import { BROWSE_CATEGORIES, BROWSE_MAX_PAGES, BROWSE_SLUGS } from "./browse";
import {
  CALENDAR_KINDS, CALENDAR_KIND_SLUGS, CALENDAR_MAX_PER_DAY, CALENDAR_MAX_YEAR, CALENDAR_MIN_YEAR,
  dayKey, daysInMonth, monthKey,
} from "./release-calendar";

const BASE = "https://api.themoviedb.org/3";

async function tmdb<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  const key = process.env.TMDB_API_KEY;
  if (!key) throw new Error("TMDB_API_KEY not configured");
  const url = new URL(BASE + path);
  url.searchParams.set("api_key", key);
  url.searchParams.set("language", "en-US");
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`TMDB ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

export const getHomeFeed = createServerFn({ method: "GET" }).handler(async () => {
  const [trending, popularMovies, popularTV, topMovies, topTV, upcoming] = await Promise.all([
    tmdb<{ results: MediaItem[] }>("/trending/all/day"),
    tmdb<{ results: MediaItem[] }>("/movie/popular"),
    tmdb<{ results: MediaItem[] }>("/tv/popular"),
    tmdb<{ results: MediaItem[] }>("/movie/top_rated"),
    tmdb<{ results: MediaItem[] }>("/tv/top_rated"),
    tmdb<{ results: MediaItem[] }>("/movie/upcoming"),
  ]);
  return {
    trending: trending.results.slice(0, 20),
    popularMovies: popularMovies.results.slice(0, 20),
    popularTV: popularTV.results.slice(0, 20),
    topMovies: topMovies.results.slice(0, 20),
    topTV: topTV.results.slice(0, 20),
    upcoming: upcoming.results.slice(0, 20),
  };
});

/** One page (20 titles) of a Home row's full list, for the "See more" grid page. */
export const getBrowsePage = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) =>
    z.object({ category: z.enum(BROWSE_SLUGS), page: z.number().int().min(1).max(BROWSE_MAX_PAGES) }).parse(d),
  )
  .handler(async ({ data }) => {
    const cfg = BROWSE_CATEGORIES[data.category];
    const res = await tmdb<{ results: MediaItem[]; total_pages: number }>(cfg.path, { page: data.page });
    const results = res.results
      // The movie / TV lists do not say what they are; the "trending" list does.
      .map((r) => (cfg.mediaType ? { ...r, media_type: cfg.mediaType } : r))
      .filter((r) => r.media_type !== "person");
    return { results, page: data.page, totalPages: Math.min(res.total_pages, BROWSE_MAX_PAGES) };
  });

/**
 * One page (20 movies) of a studio's films, newest or most popular first, for the studio page. The first page also
 * carries the studio's name and logo.
 */
export const getStudioPage = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) =>
    z.object({
      id: z.number().int().positive(),
      page: z.number().int().min(1).max(500),
      sort: z.enum(["newest", "popular"]).default("newest"),
    }).parse(d),
  )
  .handler(async ({ data }) => {
    const [res, studio] = await Promise.all([
      tmdb<{ results: MediaItem[]; total_pages: number; total_results: number }>("/discover/movie", {
        with_companies: data.id,
        sort_by: data.sort === "popular" ? "popularity.desc" : "primary_release_date.desc",
        page: data.page,
      }),
      data.page === 1
        ? tmdb<{ name: string; logo_path: string | null }>(`/company/${data.id}`)
        : Promise.resolve(null),
    ]);
    return {
      results: res.results.map((r) => ({ ...r, media_type: "movie" as const })),
      page: data.page,
      totalPages: Math.min(res.total_pages, 500), // TMDB serves no more than 500 pages of a list
      total: res.total_results,
      studio: studio ? { name: studio.name, logoPath: studio.logo_path } : null,
    };
  });

/** A film series ("Toy Story Collection") with its movies in release order; ones with no date yet go last. */
export const getCollection = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => z.object({ id: z.number().int().positive() }).parse(d))
  .handler(async ({ data }) => {
    const res = await tmdb<{ name: string; overview?: string; parts?: MediaItem[] }>(`/collection/${data.id}`);
    const parts = (res.parts ?? [])
      .map((r) => ({ ...r, media_type: "movie" as const }))
      .sort((a, b) => (a.release_date || "9999").localeCompare(b.release_date || "9999"));
    return { name: res.name, overview: res.overview ?? "", parts };
  });

/** A cut-down title for the Calendar (no overview/credits: a month is hundreds of titles). */
type CalendarTitle = Pick<MediaItem, "id" | "title" | "poster_path" | "vote_average" | "release_date">;

// A month already looked up is kept in memory for a while (a month is ~30 TMDB calls on a miss). Past months
// do not change, so they are kept for a week; the current and coming months for a few hours.
const calendarCache = new Map<string, { at: number; days: Record<string, CalendarTitle[]> }>();
const CALENDAR_CACHE_MAX = 60;

/**
 * Which movies are released on each day of one month, in one country. TMDB can only filter by a release TYPE
 * (cinema, digital...) together with a date range, and the date it reports is not always the one in range, so
 * each day is asked for on its own: a movie then lands on exactly the day it came out in that country.
 */
export const getReleaseCalendar = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) =>
    z.object({
      year: z.number().int().min(CALENDAR_MIN_YEAR).max(CALENDAR_MAX_YEAR),
      month: z.number().int().min(1).max(12),
      kind: z.enum(CALENDAR_KIND_SLUGS),
      region: z.string().regex(/^[A-Z]{2}$/),
      refresh: z.boolean().optional(),
    }).parse(d),
  )
  .handler(async ({ data }) => {
    const month = { year: data.year, month: data.month };
    const cacheKey = `${data.region}|${data.kind}|${monthKey(month)}`;
    const cached = calendarCache.get(cacheKey);
    const isPast = Date.UTC(data.year, data.month, 1) < Date.now() - 1000 * 60 * 60 * 24 * 7;
    const ttl = isPast ? 1000 * 60 * 60 * 24 * 7 : 1000 * 60 * 60 * 3;
    // "Refresh" skips what is kept, but not more than once a minute per month.
    const wantFresh = data.refresh === true && (!cached || Date.now() - cached.at > 1000 * 60);
    if (cached && !wantFresh && Date.now() - cached.at < ttl) return { ...data, days: cached.days };

    const types = CALENDAR_KINDS[data.kind].releaseTypes;
    const results = await Promise.all(
      Array.from({ length: daysInMonth(month) }, async (_, i) => {
        const day = dayKey(month, i + 1);
        const res = await tmdb<{ results: MediaItem[] }>("/discover/movie", {
          region: data.region,
          with_release_type: types,
          "release_date.gte": day,
          "release_date.lte": day,
          sort_by: "popularity.desc",
          include_adult: "false",
          page: 1,
        });
        const titles: CalendarTitle[] = res.results.slice(0, CALENDAR_MAX_PER_DAY).map((r) => ({
          id: r.id,
          title: r.title,
          poster_path: r.poster_path ?? null,
          vote_average: r.vote_average,
          release_date: r.release_date,
        }));
        return [day, titles] as const;
      }),
    );
    const days: Record<string, CalendarTitle[]> = {};
    for (const [day, titles] of results) if (titles.length > 0) days[day] = titles;

    if (calendarCache.size >= CALENDAR_CACHE_MAX) calendarCache.delete(calendarCache.keys().next().value!);
    calendarCache.set(cacheKey, { at: Date.now(), days });
    return { ...data, days };
  });

// whentostream's slug -> the TMDB movie it is (or null when no confident match), so a tile can open our own movie page.
type WtsMatch = { id: number; poster_path: string | null; release_date: string | null };
const wtsMatchCache = new Map<string, WtsMatch | null>();

const normTitle = (s: string) => s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "");

async function matchTmdbMovie(slug: string, title: string, yearHint: number | null): Promise<WtsMatch | null> {
  if (wtsMatchCache.has(slug)) return wtsMatchCache.get(slug)!;
  let found: MediaItem | null = null;
  try {
    const res = await tmdb<{ results: (MediaItem & { original_title?: string })[] }>("/search/movie", {
      query: title, include_adult: "false",
    });
    const want = normTitle(title);
    const exact = res.results.filter((r) => normTitle(r.title ?? "") === want || normTitle(r.original_title ?? "") === want);
    const near = yearHint
      ? exact.find((r) => {
          const y = Number((r.release_date ?? "").slice(0, 4));
          return y && Math.abs(y - yearHint) <= 1;
        })
      : undefined;
    found = near ?? (exact.length === 1 ? exact[0] : null);
  } catch {
    return null; // a failed lookup is not remembered
  }
  const id: WtsMatch | null = found
    ? { id: found.id, poster_path: found.poster_path ?? null, release_date: found.release_date ?? null }
    : null;
  wtsMatchCache.set(slug, id);
  if (wtsMatchCache.size > 5000) wtsMatchCache.delete(wtsMatchCache.keys().next().value!);
  return id;
}

/** The TMDB movie a whentostream calendar entry is, by its title and year (see matchTmdbMovie). */
async function matchWtsEntry(e: { slug: string; details: { title: string; year: number | null; theaterDate: string | null } | null }) {
  const { titleFromSlug } = await import("@/server/whentostream.server");
  const slugYear = Number(/-((?:19|20)\d{2})$/.exec(e.slug)?.[1]) || null;
  const title = e.details?.title ?? titleFromSlug(e.slug);
  const hint = e.details?.theaterDate ? Number(e.details.theaterDate.slice(0, 4)) : (e.details?.year ?? slugYear);
  return matchTmdbMovie(e.slug, title, hint);
}

/**
 * US home release dates (YYYY-MM-DD) from whentostream.com's streaming calendars for last month, this month and next
 * month, by TMDB id: the fallback for films TMDB has no digital date for (it often has none for smaller films, e.g.
 * "The Last Temptation of Becky"). A film's date is the earliest it is listed under, or its VOD/SVOD date if earlier.
 * The same month pages the Calendar reads (kept in memory by getWtsMonth); this map is rebuilt every 3 hours, and
 * while it is rebuilt the previous one is used.
 */
const WTS_HOME_TTL_MS = 3 * 60 * 60 * 1000;
let wtsHome: { at: number; dates: Map<number, string> } | null = null;
let wtsHomeBuilding: Promise<Map<number, string>> | null = null;

async function buildWtsHomeDates(): Promise<{ dates: Map<number, string>; complete: boolean }> {
  const { getWtsMonth, mapLimit } = await import("@/server/whentostream.server");
  const now = new Date();
  const dates = new Map<number, string>();
  let complete = true;
  for (const step of [-1, 0, 1]) {
    const m = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + step, 1));
    const entries = await getWtsMonth("streaming", m.getUTCFullYear(), m.getUTCMonth() + 1);
    if (!entries) {
      // Next month's calendar is often not up yet; any other month missing means the site could not be read.
      if (step !== 1) complete = false;
      continue;
    }
    const bySlug = new Map<string, { entry: (typeof entries)[number]; date: string }>();
    for (const e of entries) {
      const date = [e.day, e.details?.vodDate, e.details?.svodDate]
        .filter((d): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d))
        .sort()[0];
      if (!date) continue;
      const had = bySlug.get(e.slug);
      if (!had || date < had.date) bySlug.set(e.slug, { entry: had?.entry ?? e, date });
    }
    await mapLimit([...bySlug.values()], 6, async ({ entry, date }) => {
      const match = await matchWtsEntry(entry);
      if (!match) return;
      const had = dates.get(match.id);
      if (!had || date < had) dates.set(match.id, date);
    });
  }
  return { dates, complete };
}

/**
 * The whentostream home dates, waiting at most `waitMs` for a first build (null when it is not ready by then; it keeps
 * building for the next request). A build that could not read the site is retried after 10 minutes.
 */
export async function getWtsHomeDates(waitMs: number): Promise<Map<number, string> | null> {
  const fresh = wtsHome && Date.now() - wtsHome.at < WTS_HOME_TTL_MS;
  if (fresh) return wtsHome!.dates;
  if (!wtsHomeBuilding) {
    wtsHomeBuilding = buildWtsHomeDates()
      .then(({ dates, complete }) => {
        wtsHome = { at: complete ? Date.now() : Date.now() - WTS_HOME_TTL_MS + 10 * 60 * 1000, dates };
        return dates;
      })
      .finally(() => {
        wtsHomeBuilding = null;
      });
  }
  if (wtsHome) return wtsHome.dates; // stale, while the new one builds
  const building = wtsHomeBuilding.catch(() => null);
  return Promise.race([building, new Promise<null>((r) => setTimeout(() => r(null), waitMs))]);
}

/**
 * One month of whentostream.com's calendar (streaming or in-theaters), with each movie's details and, where a
 * confident match exists, its TMDB id. `available: false` when the site has no calendar for that month.
 */
export const getWhenToStreamMonth = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) =>
    z.object({
      year: z.number().int().min(CALENDAR_MIN_YEAR).max(CALENDAR_MAX_YEAR),
      month: z.number().int().min(1).max(12),
      kind: z.enum(["streaming", "theatrical"]),
      /** The Refresh button: read the site again instead of using what is kept (at most once a minute per month). */
      refresh: z.boolean().optional(),
    }).parse(d),
  )
  .handler(async ({ data }) => {
    const { getWtsMonth, titleFromSlug, mapLimit } = await import("@/server/whentostream.server");
    const entries = await getWtsMonth(data.kind, data.year, data.month, data.refresh);
    if (!entries) return { available: false as const };

    const bySlug = new Map<string, (typeof entries)[number]>();
    for (const e of entries) if (!bySlug.has(e.slug)) bySlug.set(e.slug, e);
    const ids = new Map<string, WtsMatch | null>();
    await mapLimit([...bySlug.values()], 6, async (e) => {
      ids.set(e.slug, await matchWtsEntry(e));
    });

    return {
      available: true as const,
      year: data.year,
      month: data.month,
      kind: data.kind,
      entries: entries.map((e) => ({
        day: e.day,
        slug: e.slug,
        title: e.details?.title ?? titleFromSlug(e.slug),
        poster: e.poster,
        tmdbId: ids.get(e.slug)?.id ?? null,
        tmdbPoster: ids.get(e.slug)?.poster_path ?? null,
        tmdbDate: ids.get(e.slug)?.release_date ?? null,
        details: e.details,
      })),
    };
  });

export const searchMulti = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => z.object({ query: z.string().min(1).max(200) }).parse(d))
  .handler(async ({ data }) => {
    const res = await tmdb<{ results: MediaItem[] }>("/search/multi", {
      query: data.query, include_adult: "false",
    });
    return res.results.filter((r) => r.media_type !== "person" || r.profile_path).slice(0, 40);
  });

export const getMovie = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => z.object({ id: z.number().int().positive() }).parse(d))
  .handler(async ({ data }) => {
    return tmdb<MovieDetails>(`/movie/${data.id}`, {
      // keywords: TMDB tags films with a scene during or after the credits (see creditsScenes in movie.$id.tsx).
      append_to_response: "credits,videos,recommendations,release_dates,reviews,keywords",
    });
  });

export type TraktComment = {
  id: number;
  author: string;
  content: string;
  createdAt: string;
  /** The writer's own rating of the movie out of 10, when they gave one. */
  rating: number | null;
  likes: number;
  /** The writer marked the whole comment as a spoiler. */
  spoiler: boolean;
};

/**
 * One page (20) of a movie's or show's comments on Trakt, most liked first. TMDB itself has very few reviews (often
 * under a dozen even for a big film); Trakt usually has many times more. Returns null when Trakt is not
 * set up on this server or the lookup fails, so the Comments popup just shows the TMDB reviews.
 */
export const getTraktComments = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) =>
    z.object({
      imdbId: z.string().regex(/^tt\d+$/),
      page: z.number().int().min(1).max(100),
      mediaType: z.enum(["movie", "tv"]).default("movie"),
      // One episode's comments: the show's IMDb id plus these.
      season: z.number().int().min(0).optional(),
      episode: z.number().int().min(0).optional(),
    }).parse(d),
  )
  .handler(async ({ data }) => {
    try {
      const { traktHeaders } = await import("@/lib/trakt.server");
      const base = `https://api.trakt.tv/${data.mediaType === "tv" ? "shows" : "movies"}/${data.imdbId}`;
      const where =
        data.mediaType === "tv" && data.season !== undefined && data.episode !== undefined
          ? `${base}/seasons/${data.season}/episodes/${data.episode}`
          : base;
      const res = await fetch(
        `${where}/comments/likes?page=${data.page}&limit=20`,
        { headers: traktHeaders(), signal: AbortSignal.timeout(8000) },
      );
      if (!res.ok) return null;
      const rows = (await res.json()) as {
        id: number;
        comment?: string;
        created_at?: string;
        spoiler?: boolean;
        likes?: number;
        user_rating?: number | null;
        user?: { username?: string; name?: string | null };
      }[];
      const comments: TraktComment[] = rows
        .filter((r) => typeof r.comment === "string" && r.comment.trim())
        .map((r) => ({
          id: r.id,
          author: r.user?.name || r.user?.username || "Trakt user",
          content: r.comment!,
          createdAt: r.created_at ?? "",
          rating: typeof r.user_rating === "number" ? r.user_rating : null,
          likes: r.likes ?? 0,
          spoiler: r.spoiler === true,
        }));
      return {
        comments,
        page: data.page,
        totalPages: Number(res.headers.get("x-pagination-page-count")) || data.page,
        total: Number(res.headers.get("x-pagination-item-count")) || comments.length,
      };
    } catch {
      return null;
    }
  });

/**
 * "What people are saying" about a movie or show: Trakt's short summary of its comments, as a few good points and a
 * few bad ones. Returns null when Trakt is not set up, has no summary for the movie, or the lookup fails.
 */
export const getTraktSentiments = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) =>
    z.object({ imdbId: z.string().regex(/^tt\d+$/), mediaType: z.enum(["movie", "tv"]).default("movie") }).parse(d),
  )
  .handler(async ({ data }) => {
    try {
      const { traktHeaders } = await import("@/lib/trakt.server");
      const res = await fetch(`https://api.trakt.tv/${data.mediaType === "tv" ? "shows" : "movies"}/${data.imdbId}/sentiments`, {
        headers: traktHeaders(),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return null;
      const j = (await res.json()) as { good?: { sentiment?: unknown }[]; bad?: { sentiment?: unknown }[] };
      const lines = (list: { sentiment?: unknown }[] | undefined) =>
        (Array.isArray(list) ? list : [])
          .map((s) => (typeof s?.sentiment === "string" ? s.sentiment.trim() : ""))
          .filter(Boolean)
          .slice(0, 3);
      const good = lines(j.good);
      const bad = lines(j.bad);
      return good.length || bad.length ? { good, bad } : null;
    } catch {
      return null;
    }
  });

export const getTV = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => z.object({ id: z.number().int().positive() }).parse(d))
  .handler(async ({ data }) => {
    return tmdb<TVDetails>(`/tv/${data.id}`, {
      append_to_response: "credits,videos,recommendations,content_ratings,external_ids,reviews",
    });
  });

/** One person on a cast page: who they play and, for a show, in how many episodes. */
export type CastEntry = { id: number; name: string; profile_path: string | null; character: string; episodes?: number };

/**
 * A show's whole cast, from every season (the show page's `credits` only has the latest season's regulars), in
 * TMDB's order (most episodes first). Someone who played several parts has them joined with " / ".
 */
export const getTVCast = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => z.object({ id: z.number().int().positive() }).parse(d))
  .handler(async ({ data }): Promise<CastEntry[]> => {
    const res = await tmdb<{
      cast?: {
        id: number;
        name: string;
        profile_path: string | null;
        roles?: { character?: string; episode_count?: number }[];
        total_episode_count?: number;
      }[];
    }>(`/tv/${data.id}/aggregate_credits`);
    return (res.cast ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      profile_path: c.profile_path,
      character: [...new Set((c.roles ?? []).map((r) => r.character?.trim() ?? "").filter(Boolean))].join(" / "),
      episodes: c.total_episode_count,
    }));
  });

export const getWatchProviders = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) =>
    z.object({
      mediaType: z.enum(["movie", "tv"]),
      id: z.number().int().positive(),
    }).parse(d),
  )
  .handler(async ({ data }) => {
    const res = await tmdb<{ results: Record<string, ProviderRegion> }>(
      `/${data.mediaType}/${data.id}/watch/providers`,
    );
    return res.results ?? {};
  });

type Provider = { provider_id: number; provider_name: string; logo_path: string | null; display_priority?: number };
type ProviderRegion = {
  link?: string;
  flatrate?: Provider[];
  rent?: Provider[];
  buy?: Provider[];
  ads?: Provider[];
  free?: Provider[];
};

type OmdbRatings = {
  imdb: string | null;
  imdbVotes: string | null;
  rottenTomatoes: string | null;
  metascore: string | null;
};

/** OMDb's ratings for one title, or null when OMDb has no key, no such title, or the lookup failed. */
async function fetchOmdbRatings(imdbId: string): Promise<OmdbRatings | null> {
  const key = process.env.OMDB_API_KEY;
  if (!key) return null;
  try {
    const url = new URL("https://www.omdbapi.com/");
    url.searchParams.set("apikey", key);
    url.searchParams.set("i", imdbId);
    url.searchParams.set("tomatoes", "true");
    const res = await fetch(url.toString());
    if (!res.ok) return null;
    const j = (await res.json()) as {
      Response?: string;
      Ratings?: { Source: string; Value: string }[];
      imdbRating?: string;
      imdbVotes?: string;
      Metascore?: string;
    };
    if (j.Response === "False") return null;
    return {
      imdb: j.imdbRating && j.imdbRating !== "N/A" ? j.imdbRating : null,
      imdbVotes: j.imdbVotes && j.imdbVotes !== "N/A" ? j.imdbVotes : null,
      rottenTomatoes: j.Ratings?.find((r) => r.Source === "Rotten Tomatoes")?.Value ?? null,
      metascore: j.Metascore && j.Metascore !== "N/A" ? j.Metascore : null,
    };
  } catch {
    return null;
  }
}

/**
 * IMDb / Rotten Tomatoes / Metacritic for a title, for the ratings row on movie and show pages.
 * OMDb supplies IMDb, Metacritic and a Rotten Tomatoes critics' score (often missing for recent
 * releases). MDBList, if MDBLIST_API_KEY is set, supplies the critics' score with its review count and
 * the audience score, and is preferred for the critics' score. Both are looked up at the same time.
 * See src/server/mdblist.server.ts, which caches and refreshes the MDBList answers.
 */
export const getOmdbRatings = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) =>
    z.object({ imdbId: z.string().regex(/^tt\d+$/), mediaType: z.enum(["movie", "tv"]).default("movie") }).parse(d),
  )
  .handler(async ({ data }) => {
    const { getMdblistScores } = await import("@/server/mdblist.server");
    const [omdb, mdb] = await Promise.all([
      fetchOmdbRatings(data.imdbId),
      getMdblistScores(data.imdbId, data.mediaType === "tv" ? "show" : "movie"),
    ]);
    const omdbCritics = omdb?.rottenTomatoes ? parseInt(omdb.rottenTomatoes, 10) : NaN;
    const criticsScore = mdb?.rt ?? (Number.isNaN(omdbCritics) ? null : omdbCritics);
    const audienceScore = mdb?.audience ?? null;
    if (!omdb && criticsScore === null && audienceScore === null) return null;
    return {
      imdb: omdb?.imdb ?? null,
      imdbVotes: omdb?.imdbVotes ?? null,
      metascore: omdb?.metascore ?? null,
      /** Tomatometer, percent. */
      criticsScore,
      /** Number of critic reviews behind it, when known (MDBList only). */
      criticsReviews: mdb?.rt != null ? mdb.rtReviews : null,
      /** Popcornmeter (audience), percent. */
      audienceScore,
      /** Number of audience ratings behind it, when known (MDBList only). */
      audienceVotes: audienceScore !== null ? mdb?.audienceVotes ?? null : null,
      /** The title's Rotten Tomatoes page, when MDBList knows it. */
      rottenTomatoesUrl: mdb?.rtPath ? `https://www.rottentomatoes.com${mdb.rtPath}` : null,
    };
  });

export type ParentsGuideCategory =
  | "SEXUAL_CONTENT"
  | "VIOLENCE"
  | "PROFANITY"
  | "ALCOHOL_DRUGS"
  | "FRIGHTENING_INTENSE_SCENES";

export type ParentsGuideSeverity = "none" | "mild" | "moderate" | "severe";

export type ParentsGuideItem = {
  category: ParentsGuideCategory;
  severity: ParentsGuideSeverity | null;
  votes: Record<ParentsGuideSeverity, number>;
  totalVotes: number;
  reviews: { text: string; isSpoiler?: boolean }[];
};

export const getParentsGuide = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => z.object({ imdbId: z.string().regex(/^tt\d+$/) }).parse(d))
  .handler(async ({ data }) => {
    const { getParentsGuideCache, setParentsGuideCache } = await import("@/server/cache.server");
    // Read cache first so we always have a fallback, then try for fresher data.
    let cachedItems: ParentsGuideItem[] | null = null;
    try {
      const c = getParentsGuideCache<ParentsGuideItem[]>(data.imdbId);
      if (c?.length) cachedItems = c;
    } catch {
      // ignore cache read failures
    }
    try {
      const query = `query($id:ID!){title(id:$id){parentsGuide{categories{category{id} severity{id} totalSeverityVotes guideItems(first:10){edges{node{text{plainText} isSpoiler}}}}}}}`;
      const res = await fetch("https://caching.graphql.imdb.com/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0",
          "x-imdb-client-name": "imdb-web-next",
        },
        body: JSON.stringify({ query, variables: { id: data.imdbId } }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return cachedItems;
      const json = (await res.json()) as {
        data?: {
          title?: {
            parentsGuide?: {
              categories?: {
                category?: { id?: string };
                severity?: { id?: string } | null;
                totalSeverityVotes?: number;
                guideItems?: { edges?: { node?: { text?: { plainText?: string }; isSpoiler?: boolean } }[] };
              }[];
            };
          };
        };
      };
      const CATEGORY_MAP: Record<string, ParentsGuideCategory> = {
        NUDITY: "SEXUAL_CONTENT",
        VIOLENCE: "VIOLENCE",
        PROFANITY: "PROFANITY",
        ALCOHOL: "ALCOHOL_DRUGS",
        FRIGHTENING: "FRIGHTENING_INTENSE_SCENES",
      };
      const SEVERITY_MAP: Record<string, ParentsGuideSeverity> = {
        noneVotes: "none",
        mildVotes: "mild",
        moderateVotes: "moderate",
        severeVotes: "severe",
      };
      const items: ParentsGuideItem[] = (json.data?.title?.parentsGuide?.categories ?? [])
        .map((c): ParentsGuideItem | null => {
          const category = CATEGORY_MAP[c.category?.id ?? ""];
          if (!category) return null;
          const severity = c.severity?.id ? (SEVERITY_MAP[c.severity.id] ?? null) : null;
          const total = c.totalSeverityVotes ?? 0;
          const votes: Record<ParentsGuideSeverity, number> = { none: 0, mild: 0, moderate: 0, severe: 0 };
          if (severity) votes[severity] = total;
          const reviews = (c.guideItems?.edges ?? [])
            .map((e) => ({ text: e.node?.text?.plainText ?? "", isSpoiler: e.node?.isSpoiler ?? false }))
            .filter((r) => r.text.length > 0);
          return { category, severity, votes, totalVotes: total, reviews };
        })
        .filter((x): x is ParentsGuideItem => x !== null);
      if (items.length === 0) return cachedItems;
      if (JSON.stringify(items) !== JSON.stringify(cachedItems)) {
        try {
          setParentsGuideCache(data.imdbId, items);
        } catch {
          // caching is best-effort
        }
      }
      return items;
    } catch {
      return cachedItems;
    }
  });

/** A movie's distributor, and the TMDB company that stands for it (for its logo and the studio page) when one matches. */
export type Distributor = {
  name: string;
  company: { id: number; name: string; logo_path: string } | null;
};

const DISTRIBUTOR_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DISTRIBUTOR_MISS_TTL_MS = 24 * 60 * 60 * 1000;

/** A company name boiled down for matching: "Warner Bros. Pictures" and "Warner Bros." both become "warner bros". */
function companyCore(name: string): string {
  let s = name
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ") // "(UPI)", "(Australasia)"
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/^the\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
  const tail = /\s(pictures?|films?|motion|entertainment|studios?|releasing|distribution|corporation|corp|company|co|inc|llc|ltd)$/;
  while (tail.test(s)) s = s.replace(tail, "");
  return s;
}

// Distributors whose name finds the wrong TMDB company by search. ("Warner Bros." would find Warner Bros.
// Entertainment, which has very few films on TMDB; Warner Bros. Pictures has them all.)
const DISTRIBUTOR_COMPANY_IDS: Record<string, number> = {
  "warner bros": 174,
  "twentieth century fox": 25,
  "20th century fox": 25,
};

/**
 * Who released a movie in US cinemas, from IMDb's "Distributors" list (TMDB does not record distributors). When
 * it had no US cinema release, the worldwide or US streaming one (Netflix, Apple...) is used. The name is then
 * matched to a TMDB company with a logo. Null when IMDb lists none. Kept for a month.
 */
export const getDistributor = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => z.object({ imdbId: z.string().regex(/^tt\d+$/) }).parse(d))
  .handler(async ({ data }): Promise<Distributor | null> => {
    const { getCachedEntry, setCachedMany } = await import("@/server/tmdb-cache.server");
    const key = `distributor:movie:${data.imdbId}`;
    const hit = getCachedEntry<Distributor | null>(key);
    if (hit && Date.now() - hit.fetchedAt < (hit.value ? DISTRIBUTOR_TTL_MS : DISTRIBUTOR_MISS_TTL_MS)) return hit.value;

    type Credit = { name: string; countries: string[]; year: number; attrs: string[] };
    let credits: Credit[];
    try {
      const query = `query($id:ID!){title(id:$id){companyCredits(first:100,filter:{categories:["distribution"]}){edges{node{company{id companyText{text}} countries{id} yearsInvolved{year} attributes{text}}}}}}`;
      const res = await fetch("https://caching.graphql.imdb.com/", {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0", "x-imdb-client-name": "imdb-web-next" },
        body: JSON.stringify({ query, variables: { id: data.imdbId } }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return hit?.value ?? null;
      const json = (await res.json()) as {
        data?: { title?: { companyCredits?: { edges?: { node?: {
          company?: { companyText?: { text?: string } };
          countries?: { id?: string }[] | null;
          yearsInvolved?: { year?: number } | null;
          attributes?: { text?: string }[] | null;
        } }[] } } };
      };
      credits = (json.data?.title?.companyCredits?.edges ?? [])
        .map((e) => ({
          name: e.node?.company?.companyText?.text?.trim() ?? "",
          countries: (e.node?.countries ?? []).map((c) => c.id ?? ""),
          year: e.node?.yearsInvolved?.year ?? 9999,
          attrs: (e.node?.attributes ?? []).map((a) => (a.text ?? "").toLowerCase()),
        }))
        .filter((c) => c.name);
    } catch {
      return hit?.value ?? null;
    }

    // DVD, Blu-ray and TV releases are not who released the film.
    const homeVideo = (c: Credit) => c.attrs.some((a) => /dvd|blu-ray|vhs|laserdisc|^tv$|airline|ships/.test(a));
    const theatrical = (c: Credit) => c.attrs.includes("theatrical");
    const inCountry = (code: string) => (c: Credit) => c.countries.includes(code);
    const earliest = (list: Credit[]) => [...list].sort((a, b) => a.year - b.year)[0];
    const pick =
      earliest(credits.filter((c) => theatrical(c) && inCountry("US")(c))) ??
      earliest(credits.filter((c) => theatrical(c) && inCountry("XWW")(c))) ??
      earliest(credits.filter((c) => !homeVideo(c) && inCountry("XWW")(c))) ??
      earliest(credits.filter((c) => !homeVideo(c) && inCountry("US")(c)));

    let result: Distributor | null = null;
    if (pick) {
      result = { name: pick.name, company: null };
      try {
        const core = companyCore(pick.name);
        type Company = { id: number; name: string; logo_path: string | null; origin_country?: string };
        const fixedId = DISTRIBUTOR_COMPANY_IDS[core];
        let found: Company | undefined;
        if (fixedId) {
          found = await tmdb<Company>(`/company/${fixedId}`);
        } else {
          const res = await tmdb<{ results: Company[] }>("/search/company", { query: pick.name });
          const exact = pick.name.toLowerCase();
          found = res.results
            .filter((c) => c.logo_path && companyCore(c.name) === core)
            .sort((a, b) =>
              Number(b.origin_country === "US") - Number(a.origin_country === "US") ||
              Number(b.name.toLowerCase() === exact) - Number(a.name.toLowerCase() === exact),
            )[0];
        }
        if (found?.logo_path) result.company = { id: found.id, name: found.name, logo_path: found.logo_path };
      } catch {
        // No logo this time (TMDB did not answer); the name is still shown, and this is not kept.
        return result;
      }
    }
    try {
      setCachedMany([[key, result]]);
    } catch {
      // caching is best-effort
    }
    return result;
  });

export const getSeason = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) =>
    z.object({ id: z.number().int().positive(), seasonNumber: z.number().int().min(0) }).parse(d),
  )
  .handler(async ({ data }) => {
    return tmdb<SeasonDetails>(`/tv/${data.id}/season/${data.seasonNumber}`);
  });

/** One episode in full for its own page: who is in it and who made it, its IMDb id (for ratings), its stills. */
export const getEpisode = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) =>
    z.object({
      id: z.number().int().positive(),
      seasonNumber: z.number().int().min(0),
      episodeNumber: z.number().int().min(0),
    }).parse(d),
  )
  .handler(async ({ data }) => {
    return tmdb<EpisodeDetails>(`/tv/${data.id}/season/${data.seasonNumber}/episode/${data.episodeNumber}`, {
      append_to_response: "credits,external_ids,images",
    });
  });

/** One episode for the "time remaining" sum: [season, episode, runtime in minutes or null, air date or null]. */
export type EpisodeRuntime = [season: number, episode: number, runtime: number | null, airDate: string | null];
const RUNTIMES_TTL_MS = 1000 * 60 * 60 * 12; // new episodes get dates and lengths as they come out

/**
 * Every episode's length and air date for the given seasons of a show, for the "~3h 23m remaining" beside its
 * seasons. TMDB lets 20 seasons come with one request, so even a long show is only a few. Kept for 12 hours.
 */
export const getShowRuntimes = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) =>
    z.object({ id: z.number().int().positive(), seasons: z.array(z.number().int().min(0)).max(200) }).parse(d),
  )
  .handler(async ({ data }): Promise<EpisodeRuntime[]> => {
    const { getCachedEntry, setCachedMany } = await import("@/server/tmdb-cache.server");
    const seasons = [...new Set(data.seasons)].sort((a, b) => a - b);
    const key = `runtimes:tv:${data.id}:${seasons.join(",")}`;
    const hit = getCachedEntry<EpisodeRuntime[]>(key);
    if (hit && Date.now() - hit.fetchedAt < RUNTIMES_TTL_MS) return hit.value;

    type SeasonEpisodes = { episodes?: { season_number: number; episode_number: number; runtime?: number | null; air_date?: string | null }[] };
    const chunks: number[][] = [];
    for (let i = 0; i < seasons.length; i += 20) chunks.push(seasons.slice(i, i + 20));
    const pages = await Promise.all(
      chunks.map((chunk) =>
        tmdb<Record<string, SeasonEpisodes | unknown>>(`/tv/${data.id}`, {
          append_to_response: chunk.map((n) => `season/${n}`).join(","),
        }),
      ),
    );
    const out: EpisodeRuntime[] = [];
    for (const page of pages) {
      for (const [k, v] of Object.entries(page)) {
        if (!k.startsWith("season/")) continue;
        for (const e of (v as SeasonEpisodes).episodes ?? []) {
          out.push([e.season_number, e.episode_number, e.runtime || null, e.air_date || null]);
        }
      }
    }
    setCachedMany([[key, out]]);
    return out;
  });

export const getPerson = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => z.object({ id: z.number().int().positive() }).parse(d))
  .handler(async ({ data }) => {
    return tmdb<PersonDetails>(`/person/${data.id}`, {
      append_to_response: "combined_credits,external_ids",
    });
  });

/** A person's English Wikipedia address (null: they have none; undefined: Wikidata couldn't be reached). */
export const getPersonWiki = createServerFn({ method: "GET" })
  .middleware([requireUser])
  .inputValidator((d: unknown) => z.object({ wikidataId: z.string().regex(/^Q\d+$/) }).parse(d))
  .handler(async ({ data }) => {
    const { getPersonWikiUrl } = await import("@/server/wiki-person.server");
    return (await getPersonWikiUrl(data.wikidataId)) ?? null;
  });

/**
 * Where an episode's Wikipedia button goes: its own article, else its season's, else the show's (null: none has
 * one, or Wikidata or TMDB couldn't be reached). See src/server/wiki-episode.server.ts.
 */
export const getEpisodeWiki = createServerFn({ method: "GET" })
  .middleware([requireUser])
  .inputValidator((d: unknown) =>
    z.object({
      id: z.number().int().positive(),
      seasonNumber: z.number().int().min(0),
      episodeNumber: z.number().int().min(0),
    }).parse(d),
  )
  .handler(async ({ data }) => {
    const { getEpisodeWikiLink } = await import("@/server/wiki-episode.server");
    const show = `/tv/${data.id}`;
    const season = `${show}/season/${data.seasonNumber}`;
    const episode = `${season}/episode/${data.episodeNumber}`;
    const ids = () =>
      Promise.all([episode, season, show].map((p) => tmdb<{ wikidata_id?: string | null }>(`${p}/external_ids`).then((r) => r.wikidata_id)));
    return (await getEpisodeWikiLink(data.id, data.seasonNumber, data.episodeNumber, ids)) ?? null;
  });

/** A title's own JustWatch address in a country (null: none found, or JustWatch couldn't be reached). */
export const getJustWatchLink = createServerFn({ method: "GET" })
  .middleware([requireUser])
  .inputValidator((d: unknown) =>
    z
      .object({
        mediaType: z.enum(["movie", "tv"]),
        id: z.number().int().positive(),
        imdbId: z.string().regex(/^tt\d+$/).nullable(),
        titles: z.array(z.string().max(300)).min(1).max(2),
        country: z.string().regex(/^[A-Z]{2}$/),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { getJustWatchPath } = await import("@/server/justwatch.server");
    const path = await getJustWatchPath(data.mediaType, data.id, data.imdbId, data.titles, data.country);
    return path ? `https://www.justwatch.com${path}` : null;
  });

type ProvidersResponse = { results: Record<string, ProviderRegion> };
type ReleaseDatesResponse = {
  results: {
    iso_3166_1: string;
    release_dates: { type: number; release_date: string }[];
  }[];
};

export type MovieAvailability = {
  tmdbId: number;
  available: boolean;
  digitalDate: string | null;
  cinemaDate: string | null;
};

export type TmdbScore = {
  mediaType: "movie" | "tv";
  tmdbId: number;
  voteAverage: number | null;
  /** Full release date ("2026-08-14"; a show's first air date), or null when TMDB has none / the lookup failed. */
  releaseDate: string | null;
  /** TMDB genre names ("Comedy"; a show's are TV ones such as "Sci-Fi & Fantasy"), empty when none / the lookup failed. */
  genres: string[];
};

const MediaRef = z.object({
  mediaType: z.enum(["movie", "tv"]),
  tmdbId: z.number().int().positive(),
});

/** Runs `fn` over `items`, at most `concurrency` at a time (to avoid hammering TMDB). Keeps input order. */
async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}

const SCORE_TTL_MS = 24 * 60 * 60 * 1000;
const AVAILABILITY_TTL_MS = 6 * 60 * 60 * 1000;
/**
 * A movie not watchable yet whose US digital date is from a day ahead to a week back is checked again after an hour,
 * not six: TMDB copies JustWatch's services with a delay, so they tend to appear around then, and the Watched popup /
 * movie page should show them soon after they do.
 */
const AVAILABILITY_SOON_TTL_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
function availabilityTtl(a: { available: boolean; digitalDate: string | null }, now = Date.now()): number {
  if (a.available || !a.digitalDate) return AVAILABILITY_TTL_MS;
  const d = Date.parse(a.digitalDate);
  return d <= now + DAY_MS && d >= now - 7 * DAY_MS ? AVAILABILITY_SOON_TTL_MS : AVAILABILITY_TTL_MS;
}
/** With no digital date known, how long after the US cinema release a buy-only listing still counts as a pre-order. */
const PREORDER_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Batch fetch TMDB vote_average, and the full release date, for a set of movie/tv items.
 * Used by Library and Lists pages where stored rows don't include score. (Lists imported from Trakt only store the
 * release year, so the full date from here is what their Release date sort and Released pill use.)
 * Both come from the same TMDB call and are cached for a day (see tmdb-cache.server.ts); a failed lookup returns
 * null and is not cached.
 */
export const getTmdbScores = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ items: z.array(MediaRef).max(2000) }).parse(d))
  .handler(async ({ data }) => {
    const { getCachedMany, setCachedMany } = await import("@/server/tmdb-cache.server");
    const keyOf = (it: { mediaType: string; tmdbId: number }) => `score:${it.mediaType}:${it.tmdbId}`;
    const dateKeyOf = (it: { mediaType: string; tmdbId: number }) => `rdate:${it.mediaType}:${it.tmdbId}`;
    const cached = getCachedMany<number | null>(data.items.map(keyOf), SCORE_TTL_MS);
    const cachedDates = getCachedMany<string | null>(data.items.map(dateKeyOf), SCORE_TTL_MS);
    // Genres (the Library's Filter menu) come from the same call. Titles cached before genres were added are looked
    // up once more.
    const genresKeyOf = (it: { mediaType: string; tmdbId: number }) => `genres:${it.mediaType}:${it.tmdbId}`;
    const cachedGenres = getCachedMany<string[]>(data.items.map(genresKeyOf), SCORE_TTL_MS);
    const fetched: [string, number | string | string[] | null][] = [];

    const out = await mapPool(data.items, 8, async (it): Promise<TmdbScore> => {
      const key = keyOf(it);
      const dateKey = dateKeyOf(it);
      const genresKey = genresKeyOf(it);
      if (cached.has(key) && cachedDates.has(dateKey) && cachedGenres.has(genresKey)) {
        return {
          ...it,
          voteAverage: cached.get(key)!,
          releaseDate: cachedDates.get(dateKey)!,
          genres: cachedGenres.get(genresKey)!,
        };
      }
      try {
        const res = await tmdb<{
          vote_average?: number;
          release_date?: string;
          first_air_date?: string;
          genres?: { id: number; name: string }[];
        }>(`/${it.mediaType}/${it.tmdbId}`);
        const voteAverage = typeof res.vote_average === "number" ? res.vote_average : null;
        const d = it.mediaType === "tv" ? res.first_air_date : res.release_date;
        const releaseDate = typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
        const genres = (res.genres ?? []).map((g) => g.name).filter((n) => typeof n === "string" && n !== "");
        fetched.push([key, voteAverage], [dateKey, releaseDate], [genresKey, genres]);
        return { ...it, voteAverage, releaseDate, genres };
      } catch {
        return { ...it, voteAverage: null, releaseDate: null, genres: [] };
      }
    });
    setCachedMany(fetched);
    return out;
  });

const LAST_AIRED_TTL_MS = 6 * 60 * 60 * 1000;
const LAST_AIRED_SOON_TTL_MS = 60 * 60 * 1000;

/** What is cached per show. Entries saved before `nextAir` was kept are a bare `lastAired` (string or null). */
type LastAiredEntry = { lastAired: string | null; nextAir: string | null };
const readLastAired = (v: LastAiredEntry | string | null): LastAiredEntry =>
  v !== null && typeof v === "object" ? v : { lastAired: v, nextAir: null };

/**
 * Does the show's next episode air today? TMDB gives the US day, which can be a day behind or ahead of Canberra's,
 * so the day before and after count too.
 */
function airsAroundToday(nextAir: string | null, now = Date.now()): boolean {
  if (!nextAir) return false;
  const today = Date.parse(new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(now));
  const day = Date.parse(nextAir);
  return !Number.isNaN(day) && Math.abs(day - today) <= 24 * 60 * 60 * 1000;
}

/**
 * When each show's most recent episode aired, for the Library's "Recently aired" sort. TMDB names the episode (its
 * `last_episode_to_air`) but only knows the day; Trakt has the exact time it went out (`first_aired`, UTC), so that is
 * used when Trakt is set up on this server and knows the show (looked up by its IMDb id). Otherwise the TMDB day is
 * given as "YYYY-MM-DD". `lastAired` is null when no episode has aired yet.
 * Cached for 6 hours (cache key `lastaired:tv:<id>`), but only for an hour when the show's next episode airs today,
 * so a show that has just come out moves to the top within the hour. A show whose TMDB lookup fails returns null and
 * is not cached.
 */
export const getShowsLastAired = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ ids: z.array(z.number().int().positive()).max(500) }).parse(d),
  )
  .handler(async ({ data }) => {
    const { getCachedMany, setCachedMany } = await import("@/server/tmdb-cache.server");
    const keyOf = (id: number) => `lastaired:tv:${id}`;
    // An entry from before `nextAir` was kept that says nothing has aired is treated as airing soon (it may be).
    const cached = getCachedMany<LastAiredEntry | string | null>(data.ids.map(keyOf), (v) =>
      v === null || airsAroundToday(readLastAired(v).nextAir) ? LAST_AIRED_SOON_TTL_MS : LAST_AIRED_TTL_MS,
    );
    let trakt: Record<string, string> | null = null;
    try {
      const { traktHeaders } = await import("@/lib/trakt.server");
      trakt = traktHeaders();
    } catch {
      trakt = null; // Trakt not set up: TMDB days only
    }
    const fetched: [string, LastAiredEntry][] = [];
    const isDay = (d: unknown): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);
    const out = await mapPool(data.ids, 8, async (tmdbId) => {
      const key = keyOf(tmdbId);
      if (cached.has(key)) return { tmdbId, lastAired: readLastAired(cached.get(key)!).lastAired };
      let day: string | null;
      let nextAir: string | null;
      let imdbId: string | null;
      try {
        const res = await tmdb<{
          last_episode_to_air?: { air_date?: string | null } | null;
          next_episode_to_air?: { air_date?: string | null } | null;
          external_ids?: { imdb_id?: string | null };
        }>(`/tv/${tmdbId}`, { append_to_response: "external_ids" });
        const d = res.last_episode_to_air?.air_date;
        day = isDay(d) ? d : null;
        const n = res.next_episode_to_air?.air_date;
        nextAir = isDay(n) ? n : null;
        const imdb = res.external_ids?.imdb_id;
        imdbId = typeof imdb === "string" && /^tt\d+$/.test(imdb) ? imdb : null;
      } catch {
        return { tmdbId, lastAired: null };
      }
      let lastAired = day;
      if (trakt && imdbId) {
        try {
          const res = await fetch(`https://api.trakt.tv/shows/${imdbId}/last_episode?extended=full`, {
            headers: trakt,
            signal: AbortSignal.timeout(8000),
          });
          if (res.status === 200) {
            const ep = (await res.json()) as { first_aired?: string | null };
            if (typeof ep.first_aired === "string" && !Number.isNaN(Date.parse(ep.first_aired))) lastAired = ep.first_aired;
          }
        } catch {
          // Trakt did not answer: keep the TMDB day
        }
      }
      fetched.push([key, { lastAired, nextAir }]);
      return { tmdbId, lastAired };
    });
    setCachedMany(fetched);
    return out;
  });

/**
 * For a batch of movie IDs, determine US digital availability.
 * available = US has any flatrate/rent/buy/free/ads provider today, except a buy-only listing that is a pre-order
 * (the digital date is still ahead or, with none, the US cinema release is less than 30 days old or still ahead).
 * digitalDate = earliest US Type 4 (digital) release date, if known.
 * cinemaDate = earliest US Type 3 (theatrical) release date, else Type 2 (limited theatrical), if known.
 * Cached for 6 hours. A title whose lookup fails is reported unavailable and NOT cached, so the next
 * request tries again.
 */
export const getMoviesAvailability = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ ids: z.array(z.number().int().positive()).max(500) }).parse(d),
  )
  .handler(async ({ data }) => {
    const { getCachedMany, setCachedMany } = await import("@/server/tmdb-cache.server");
    type Answer = Omit<MovieAvailability, "tmdbId">;
    // "avail4": answers saved under older names counted (some) pre-orders as available, and "avail" had no cinema date,
    // so they are not reused.
    const keyOf = (id: number) => `avail4:movie:${id}`;
    const cached = getCachedMany<Answer>(data.ids.map(keyOf), (a) => availabilityTtl(a));
    const fetched: [string, Answer][] = [];

    const out = await mapPool(data.ids, 8, async (id): Promise<MovieAvailability> => {
      const hit = cached.get(keyOf(id));
      if (hit) return { tmdbId: id, ...hit };
      try {
        let releasesOk = true;
        const [providers, releases] = await Promise.all([
          tmdb<ProvidersResponse>(`/movie/${id}/watch/providers`),
          tmdb<ReleaseDatesResponse>(`/movie/${id}/release_dates`).catch(() => {
            releasesOk = false;
            return { results: [] } as ReleaseDatesResponse;
          }),
        ]);
        const us = providers.results?.["US"];
        const usDates = releases.results?.find((r) => r.iso_3166_1 === "US")?.release_dates ?? [];
        const earliest = (type: number) =>
          usDates
            .filter((r) => r.type === type && r.release_date)
            .map((r) => r.release_date)
            .sort()[0] ?? null;
        let digitalDate: string | null = earliest(4);
        const cinemaDate = earliest(3) ?? earliest(2); // the wide release; a limited one only when there is no wide one
        // JustWatch lists pre-orders under "buy", so a film that is only up for buying before its digital release cannot
        // be watched yet. With no digital date known, a buy-only listing within PREORDER_WINDOW_MS of the US cinema
        // release (or before it) is taken as a pre-order too: films rarely go on sale at home that soon. Streaming,
        // rental or free listings still count, since those can be watched now.
        const watchNow = [us?.flatrate, us?.rent, us?.free, us?.ads].some((l) => !!l?.length);
        // No US digital date on TMDB and nothing to watch yet: whentostream's date, for a film from this year or last
        // year (or with no date at all). If its calendars are still being read, the answer is not cached.
        let wtsPending = false;
        if (!digitalDate && !watchNow) {
          const anyDate = (releases.results ?? []).flatMap((r) => r.release_dates.map((d) => d.release_date)).sort()[0];
          const year = anyDate ? Number(anyDate.slice(0, 4)) : null;
          if (!year || year >= new Date().getFullYear() - 1) {
            const wts = await getWtsHomeDates(8000);
            if (wts) digitalDate = wts.get(id) ?? null;
            else wtsPending = true;
          }
        }
        const preOrder =
          !!us?.buy?.length &&
          !watchNow &&
          (digitalDate
            ? Date.parse(digitalDate) > Date.now()
            : !!cinemaDate && Date.now() < Date.parse(cinemaDate) + PREORDER_WINDOW_MS);
        const available = watchNow || (!!us?.buy?.length && !preOrder);
        const answer: Answer = { available, digitalDate, cinemaDate };
        if (releasesOk && !wtsPending) fetched.push([keyOf(id), answer]); // never cache a half-answer
        return { tmdbId: id, ...answer };
      } catch {
        return { tmdbId: id, available: false, digitalDate: null, cinemaDate: null };
      }
    });
    setCachedMany(fetched);
    return out;
  });

/**
 * Rotten Tomatoes (critics) and IMDb scores for the pill on a batch of posters. Returns null when no
 * MDBLIST_API_KEY is set (the pill then keeps showing the TMDB score). A title with nothing known yet comes
 * back with both scores null. See the poster section of src/server/mdblist.server.ts for saving and limits.
 */
export const getPosterScores = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ items: z.array(MediaRef).max(100) }).parse(d))
  .handler(async ({ data }) => {
    if (!process.env.MDBLIST_API_KEY) return null;
    const { getPosterScore } = await import("@/server/mdblist.server");
    return mapPool(data.items, 4, async (it) => {
      const s = await getPosterScore(it.mediaType, it.tmdbId);
      return { ...it, rt: s?.rt ?? null, rtReviews: s?.rtReviews ?? null, imdb: s?.imdb ?? null };
    });
  });

/**
 * Streaming-service badges for a batch of posters: the subscription services a title is on in one
 * region. Answers come from a SQLite cache (3 days); only misses go to TMDB. A title whose lookup
 * fails comes back with no providers and is NOT cached, so the next request tries again.
 */
export const getProviderBadges = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ region: z.string().regex(/^[A-Z]{2}$/), items: z.array(MediaRef).max(100) }).parse(d),
  )
  .handler(async ({ data }) => {
    const { getFreshProviders, saveProviders, toBadgeProviders } = await import("@/server/providers.server");
    const cached = getFreshProviders(data.items, data.region);

    return mapPool(data.items, 6, async (it) => {
      const hit = cached.get(`${it.mediaType}:${it.tmdbId}`);
      if (hit) return { ...it, providers: hit };
      try {
        const res = await tmdb<ProvidersResponse>(`/${it.mediaType}/${it.tmdbId}/watch/providers`);
        const providers = toBadgeProviders(res.results?.[data.region]?.flatrate);
        saveProviders(it.mediaType, it.tmdbId, data.region, providers);
        return { ...it, providers };
      } catch {
        return { ...it, providers: [] };
      }
    });
  });
