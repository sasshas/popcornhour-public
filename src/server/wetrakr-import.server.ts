/**
 * WeTrakr import (WeTrakr -> local library). Read-only on WeTrakr and merge-only here: it adds
 * titles, episodes, ratings and list items, and moves a status forward, but never removes anything.
 * One exception to "forward only": a show marked Dropped or Paused on WeTrakr gets that status here.
 * Follows the same rules as the Trakt import (see trakt-import.server.ts and library.server.ts).
 */
import { wetrakrGet, wetrakrGetAll, type WetrakrPaged } from "./wetrakr.server.ts";
import {
  importEpisodeProgress,
  importLibraryRows,
  setLibraryRating,
  type ImportEpisodeRow,
  type ImportLibraryRow,
} from "./library.server.ts";
import { createList, findListIdByName, importListItems } from "./lists.server.ts";
import { readWetrakrListItems } from "./wetrakr-lists.server.ts";
import { logError, logInfo, redactText } from "./redact.server.ts";
import type { ProgressEvent } from "./trakt-import.server.ts";
import type { LibraryStatus } from "./types.ts";

type Ids = { tmdb?: number };
/** A movie or show as WeTrakr lists it. Movies carry release_date, shows first_air_date. */
export type WtTitle = {
  type?: string;
  ids?: Ids;
  title?: string;
  release_date?: string | null;
  first_air_date?: string | null;
  watched_at?: string | null;
  interactions?: { user?: { rating?: { rating?: number } } };
};
/** One play from /sync/tracking/watched/history/episodes. */
export type WtEpisodePlay = {
  watched_at?: string;
  episode?: { season_number?: number; number?: number; show?: { title?: string; ids?: Ids } };
};

const log = (message: string) => logInfo(`[wetrakr-import] ${message}`);

function pagedNote(p: WetrakrPaged<unknown>): string {
  const mismatch = p.reportedTotal !== null && p.reportedTotal !== p.items.length;
  return `${p.items.length} in ${p.pages} page${p.pages === 1 ? "" : "s"}` + (mismatch ? ` (WARNING: WeTrakr reported ${p.reportedTotal})` : "");
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// ---------- pure logic ----------

/** "2015-05-14T00:00:00.000Z" -> "2015-05-14". */
function day(iso: string | null | undefined): string | null {
  return iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : null;
}

/** A WeTrakr movie/show as a library row, or null when it has no TMDB id (this app is keyed by TMDB). */
export function toLibraryRow(t: WtTitle, kind: "movie" | "tv", status: LibraryStatus): ImportLibraryRow | null {
  const tmdb = t.ids?.tmdb;
  if (typeof tmdb !== "number" || !t.title) return null;
  return {
    media_type: kind,
    tmdb_id: tmdb,
    title: t.title,
    release_date: day(kind === "movie" ? t.release_date : t.first_air_date),
    status,
    ...(kind === "movie" && status === "completed" ? { watched_at: t.watched_at ?? null } : {}),
  };
}

/**
 * WeTrakr's show lists -> this app's statuses. "waiting" means caught up on a show that is still
 * airing, which this app calls completed (a new season moves it back to watching by itself).
 */
export const SHOW_LISTS: { list: string; status: LibraryStatus }[] = [
  { list: "watched", status: "completed" },
  { list: "waiting", status: "completed" },
  { list: "watching", status: "watching" },
  { list: "paused", status: "on_hold" },
  { list: "dropped", status: "dropped" },
];

export type WtEpisodeStats = { plays: number; counted: number; repeats: number; specials: number; malformed: number };

/**
 * Reduce raw plays to distinct watched episodes per show (keyed by the show's TMDB id): specials
 * (season 0) are ignored and repeat plays collapse to one episode with the latest date.
 * plays = counted + repeats + specials + malformed.
 */
export function collectWetrakrEpisodes(plays: WtEpisodePlay[]): {
  rows: ImportEpisodeRow[];
  showTitles: Map<number, string>;
  stats: WtEpisodeStats;
} {
  const stats: WtEpisodeStats = { plays: plays.length, counted: 0, repeats: 0, specials: 0, malformed: 0 };
  const seen = new Map<string, ImportEpisodeRow>();
  const showTitles = new Map<number, string>();
  for (const p of plays) {
    const tmdb = p.episode?.show?.ids?.tmdb;
    const season = p.episode?.season_number;
    const number = p.episode?.number;
    const at = p.watched_at ? Date.parse(p.watched_at) : NaN;
    if (typeof tmdb !== "number" || typeof season !== "number" || typeof number !== "number" || Number.isNaN(at)) {
      stats.malformed++;
      continue;
    }
    if (season === 0) {
      stats.specials++;
      continue;
    }
    if (p.episode?.show?.title) showTitles.set(tmdb, p.episode.show.title);
    const key = `${tmdb}:${season}x${number}`;
    const prev = seen.get(key);
    if (!prev) {
      seen.set(key, { tv_tmdb_id: tmdb, season_number: season, episode_number: number, watched_at: p.watched_at! });
      stats.counted++;
    } else {
      stats.repeats++;
      if (at > Date.parse(prev.watched_at)) prev.watched_at = p.watched_at!;
    }
  }
  return { rows: [...seen.values()], showTitles, stats };
}

/** WeTrakr rates 0-10 with one decimal; this app stores whole numbers 1-10. 0 or junk -> no rating. */
export function toRating(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.min(10, Math.max(1, Math.round(value)));
}

// ---------- IMPORT ----------

export async function* runWetrakrImport(userId: string, token: string): AsyncGenerator<ProgressEvent> {
  const summary = { history: 0, episodes: 0, watchlist: 0, ratings: 0, ratingsUnmatched: 0, lists: 0, listItems: 0 };
  const getAll = <T>(path: string) => wetrakrGetAll<T>(path, token);
  try {
    // 1. Watched movies, and shows by the list they are on
    yield { type: "phase", phase: "history", total: 0 };
    const movies = await getAll<WtTitle>("/sync/tracking/watched/movies");
    const histRows: ImportLibraryRow[] = [];
    let noTmdb = 0;
    for (const m of movies.items) {
      const row = toLibraryRow(m, "movie", "completed");
      if (row) histRows.push(row);
      else noTmdb++;
    }
    const listed = new Set<number>();
    const showNotes: string[] = [];
    for (const { list, status } of SHOW_LISTS) {
      const shows = await getAll<WtTitle>(`/sync/tracking/${list}/shows`);
      showNotes.push(`${list} ${pagedNote(shows)}`);
      for (const s of shows.items) {
        const row = toLibraryRow(s, "tv", status);
        if (!row) noTmdb++;
        else if (!listed.has(row.tmdb_id)) {
          listed.add(row.tmdb_id);
          // Dropped and Paused are the user's own decisions on WeTrakr, so they win over the status here.
          histRows.push(status === "dropped" || status === "on_hold" ? { ...row, exact_status: true } : row);
        }
      }
    }
    const plays = await getAll<WtEpisodePlay>("/sync/tracking/watched/history/episodes");
    const eps = collectWetrakrEpisodes(plays.items);
    // A show with watched episodes that is on none of the lists above still belongs in the library.
    let unlisted = 0;
    for (const tmdb of new Set(eps.rows.map((r) => r.tv_tmdb_id))) {
      if (listed.has(tmdb)) continue;
      listed.add(tmdb);
      unlisted++;
      histRows.push({
        media_type: "tv",
        tmdb_id: tmdb,
        title: eps.showTitles.get(tmdb) ?? "Unknown show",
        release_date: null,
        status: "watching",
      });
    }

    yield { type: "phase", phase: "history", total: histRows.length };
    const hist = { inserted: 0, advanced: 0, unchanged: 0, watchedAtSet: 0 };
    let i = 0;
    for (const batch of chunk(histRows, 100)) {
      const c = importLibraryRows(userId, batch);
      hist.inserted += c.inserted;
      hist.advanced += c.advanced;
      hist.unchanged += c.unchanged;
      hist.watchedAtSet += c.watchedAtSet;
      i += batch.length;
      summary.history = i;
      yield { type: "progress", phase: "history", current: i, total: histRows.length };
    }
    log(
      `history: movies ${pagedNote(movies)}; shows ${showNotes.join(", ")}, ${unlisted} more from episode plays only; ` +
        `library inserted=${hist.inserted} advanced=${hist.advanced} unchanged=${hist.unchanged} ` +
        `movie watched dates set on existing=${hist.watchedAtSet}; skipped=${noTmdb} (no tmdb id)`,
    );

    // 1b. Episodes
    yield { type: "phase", phase: "episodes", total: eps.rows.length };
    const epCounts = { inserted: 0, existing: 0 };
    let e = 0;
    for (const batch of chunk(eps.rows, 500)) {
      const c = importEpisodeProgress(userId, batch);
      epCounts.inserted += c.inserted;
      epCounts.existing += c.existing;
      e += batch.length;
      summary.episodes = e;
      yield { type: "progress", phase: "episodes", current: e, total: eps.rows.length };
    }
    const s = eps.stats;
    log(
      `episodes: plays ${pagedNote(plays)}; counted ${s.counted} distinct + repeats=${s.repeats} + specials=${s.specials} ` +
        `+ malformed=${s.malformed} of ${s.plays}; inserted=${epCounts.inserted} already-present=${epCounts.existing}`,
    );

    // 2. Watchlist ("planning"). Existing titles are never moved backward, so they stay as they are.
    yield { type: "phase", phase: "watchlist", total: 0 };
    const planMovies = await getAll<WtTitle>("/sync/tracking/planning/movies");
    const planShows = await getAll<WtTitle>("/sync/tracking/planning/shows");
    const wRows = [
      ...planMovies.items.map((t) => toLibraryRow(t, "movie", "plan_to_watch")),
      ...planShows.items.map((t) => toLibraryRow(t, "tv", "plan_to_watch")),
    ].filter((x): x is ImportLibraryRow => !!x);
    yield { type: "phase", phase: "watchlist", total: wRows.length };
    let w = 0;
    let wInserted = 0;
    for (const batch of chunk(wRows, 100)) {
      wInserted += importLibraryRows(userId, batch).inserted;
      w += batch.length;
      summary.watchlist = w;
      yield { type: "progress", phase: "watchlist", current: w, total: wRows.length };
    }
    log(
      `watchlist: movies ${pagedNote(planMovies)}, shows ${pagedNote(planShows)}; inserted=${wInserted} ` +
        `already-in-library=${wRows.length - wInserted}`,
    );

    // 3. Ratings: an update on titles already in the library (after history + watchlist, as with Trakt)
    yield { type: "phase", phase: "ratings", total: 0 };
    const ratedMovies = await getAll<WtTitle>("/sync/ratings/movies");
    const ratedShows = await getAll<WtTitle>("/sync/ratings/shows");
    const rated = [
      ...ratedMovies.items.map((t) => ({ t, kind: "movie" as const })),
      ...ratedShows.items.map((t) => ({ t, kind: "tv" as const })),
    ];
    yield { type: "phase", phase: "ratings", total: rated.length };
    let k = 0;
    let unusable = 0;
    for (const { t, kind } of rated) {
      const rating = toRating(t.interactions?.user?.rating?.rating);
      const tmdb = t.ids?.tmdb;
      if (rating === null || typeof tmdb !== "number") unusable++;
      else if (setLibraryRating(userId, kind, tmdb, rating)) summary.ratings++;
      else summary.ratingsUnmatched++;
      k++;
      if (k % 10 === 0 || k === rated.length) yield { type: "progress", phase: "ratings", current: k, total: rated.length };
    }
    log(
      `ratings: movies ${pagedNote(ratedMovies)}, shows ${pagedNote(ratedShows)}; matched=${summary.ratings} ` +
        `unmatched=${summary.ratingsUnmatched} (rated but not in the library; not inserted) unusable=${unusable}`,
    );

    // 4. Your own lists
    yield { type: "phase", phase: "lists", total: 0 };
    const lists = await wetrakrGet<{ id: number; name?: string; description?: string | null; locked?: boolean }[]>(
      "/sync/lists",
      token,
    );
    yield { type: "phase", phase: "lists", total: lists.length };
    let li = 0;
    let fetched = 0;
    let duplicates = 0;
    let skipped = 0;
    for (const l of lists) {
      li++;
      if (!l.name || l.locked) {
        yield { type: "progress", phase: "lists", current: li, total: lists.length };
        continue;
      }
      const read = await readWetrakrListItems(async (path) => (await getAll<unknown>(path)).items, l.id);
      fetched += read.items.size + read.other + read.unreadable;
      // Lists can also hold seasons, episodes and people; only movies and shows have a place here.
      const rows = [...read.items.values()]
        .map(({ kind, item }) => {
          const row = toLibraryRow(item, kind, "plan_to_watch");
          return row && { media_type: row.media_type, tmdb_id: row.tmdb_id, title: row.title, release_date: row.release_date };
        })
        .filter((x): x is NonNullable<typeof x> => !!x);
      skipped += read.other + read.unreadable + (read.items.size - rows.length);
      if (rows.length > 0) {
        let listId = findListIdByName(userId, l.name);
        if (!listId) {
          listId = createList(userId, l.name, l.description || null).id;
          summary.lists += 1;
        }
        for (const batch of chunk(rows, 100)) {
          const c = importListItems(userId, listId, batch);
          summary.listItems += c.inserted;
          duplicates += c.duplicates;
        }
      }
      yield { type: "progress", phase: "lists", current: li, total: lists.length };
    }
    log(
      `lists: ${lists.length} lists (${summary.lists} newly created); items fetched=${fetched} ` +
        `inserted=${summary.listItems} already-in-list=${duplicates} skipped=${skipped} (not a movie/show, or no tmdb id)`,
    );

    yield { type: "done", summary };
  } catch (e) {
    logError("WeTrakr import failed", e);
    yield { type: "error", message: redactText(e instanceof Error ? e.message : "Import failed") };
  }
}
