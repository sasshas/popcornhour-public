/**
 * Trakt import (Trakt -> local library) and sync (local library -> Trakt).
 *
 * Kept out of trakt.functions.ts so the logic runs as plain async generators: the server
 * functions are thin wrappers, and the whole flow can be exercised against a mocked Trakt.
 */
import { traktGetAll, traktPost, type TraktPaged } from "@/lib/trakt.server";
import {
  importEpisodeProgress,
  importLibraryRows,
  listEpisodesForSync,
  listLibraryForSync,
  setLibraryRating,
  type ImportEpisodeRow,
  type ImportLibraryRow,
} from "./library.server.ts";
import { createList, findListIdByName, importListItems } from "./lists.server.ts";
import { logError, logInfo, redactText } from "./redact.server.ts";
import type { LibraryStatus } from "./types.ts";

export type ProgressEvent =
  | { type: "phase"; phase: string; total: number }
  | { type: "progress"; phase: string; current: number; total: number }
  | { type: "done"; summary: Record<string, number> }
  | { type: "error"; message: string };

type TraktIds = { tmdb?: number; trakt?: number };
type TraktMovie = { title: string; year?: number; ids: TraktIds };
type TraktShow = { title: string; year?: number; ids: TraktIds; aired_episodes?: number };
type MediaItemEntry = { type: "movie" | "show"; movie?: TraktMovie; show?: TraktShow };

/** One entry of /sync/watched/shows?extended=full (that endpoint no longer returns seasons). */
export type WatchedShow = { plays?: number; reset_at?: string | null; show: TraktShow };

/** One play from /sync/history/episodes. */
export type HistoryEpisode = {
  watched_at: string;
  episode?: { season: number; number: number };
  show?: { ids?: TraktIds };
};

const log = (message: string) => logInfo(`[trakt-import] ${message}`);

/** "1110 in 12 pages", flagging any mismatch with the total Trakt itself reported. */
function pagedNote(p: TraktPaged<unknown>): string {
  const mismatch = p.reportedTotal !== null && p.reportedTotal !== p.items.length;
  return (
    `${p.items.length} in ${p.pages} page${p.pages === 1 ? "" : "s"}` +
    (mismatch ? ` (WARNING: Trakt reported ${p.reportedTotal})` : "")
  );
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// ---------- pure logic ----------

export type CollectedEpisode = { season: number; episode: number; watchedAt: string };

export type EpisodeStats = {
  plays: number;
  /** Distinct watched episodes (season > 0) counted across all shows, repeats collapsed. */
  counted: number;
  specials: number;
  repeats: number;
  unknownShow: number;
  malformed: number;
  /** Informational: shows carrying a reset_at, and plays that predate it. reset_at does NOT exclude plays. */
  showsWithReset: number;
  playsBeforeReset: number;
};

/**
 * Reduce raw history plays to the set of distinct watched episodes per show (keyed by Trakt show id):
 *  - season 0 (specials) is ignored;
 *  - repeated plays of one episode collapse to a single episode, keeping the latest watched_at;
 *  - a show's `reset_at` is deliberately IGNORED: every episode ever watched counts, including
 *    plays from before the user restarted the show on Trakt. (It is only tallied for the log.)
 *
 * Every play lands in exactly one bucket, so
 *   plays = counted + repeats + specials + unknownShow + malformed.
 */
export function collectEpisodes(
  shows: WatchedShow[],
  history: HistoryEpisode[],
): { perShow: Map<number, Map<string, CollectedEpisode>>; stats: EpisodeStats } {
  const resetAt = new Map<number, number | null>();
  for (const s of shows) {
    const id = s.show?.ids?.trakt;
    if (id != null) resetAt.set(id, s.reset_at ? Date.parse(s.reset_at) : null);
  }
  const stats: EpisodeStats = {
    plays: history.length,
    counted: 0,
    specials: 0,
    repeats: 0,
    unknownShow: 0,
    malformed: 0,
    showsWithReset: [...resetAt.values()].filter((r) => r != null).length,
    playsBeforeReset: 0,
  };
  const perShow = new Map<number, Map<string, CollectedEpisode>>();
  for (const h of history) {
    const sid = h.show?.ids?.trakt;
    const ep = h.episode;
    const at = h.watched_at ? Date.parse(h.watched_at) : NaN;
    if (sid == null || !ep || typeof ep.season !== "number" || typeof ep.number !== "number" || Number.isNaN(at)) {
      stats.malformed++;
      continue;
    }
    if (!resetAt.has(sid)) {
      stats.unknownShow++;
      continue;
    }
    if (ep.season === 0) {
      stats.specials++;
      continue;
    }
    const reset = resetAt.get(sid);
    if (reset != null && at < reset) stats.playsBeforeReset++; // counted all the same
    let eps = perShow.get(sid);
    if (!eps) perShow.set(sid, (eps = new Map()));
    const key = `${ep.season}x${ep.number}`;
    const prev = eps.get(key);
    if (!prev) {
      eps.set(key, { season: ep.season, episode: ep.number, watchedAt: h.watched_at });
      stats.counted++;
    } else {
      stats.repeats++;
      if (at > Date.parse(prev.watchedAt)) prev.watchedAt = h.watched_at;
    }
  }
  return { perShow, stats };
}

/**
 * Status a show gets when it is FIRST inserted. 'completed' only when every aired episode is
 * watched; any gap is 'watching'. Nothing watched at all is 'plan_to_watch'. Unknown aired count never claims 'completed'.
 */
export function decideShowStatus(
  watched: number,
  aired: number | undefined,
): { status: LibraryStatus; overAired: boolean; airedUnknown: boolean } {
  if (watched === 0) return { status: "plan_to_watch", overAired: false, airedUnknown: false };
  if (typeof aired !== "number") return { status: "watching", overAired: false, airedUnknown: true };
  if (watched >= aired) return { status: "completed", overAired: watched > aired, airedUnknown: false };
  return { status: "watching", overAired: false, airedUnknown: false };
}

type PushSeason = { number: number; episodes: { number: number; watched_at: string }[] };
export type PushShow = { ids: { tmdb: number }; seasons: PushSeason[] };
export type EpisodePushBatch = { shows: PushShow[]; episodeCount: number };

/** Group episode_progress rows into /sync/history payloads of at most `maxEpisodes` episodes. */
export function buildEpisodePushBatches(rows: ImportEpisodeRow[], maxEpisodes = 500): EpisodePushBatch[] {
  const sorted = [...rows].sort(
    (a, b) =>
      a.tv_tmdb_id - b.tv_tmdb_id || a.season_number - b.season_number || a.episode_number - b.episode_number,
  );
  const batches: EpisodePushBatch[] = [];
  let batch: EpisodePushBatch | null = null;
  let show: PushShow | null = null;
  let season: PushSeason | null = null;
  for (const r of sorted) {
    if (!batch || batch.episodeCount >= maxEpisodes) {
      batch = { shows: [], episodeCount: 0 };
      batches.push(batch);
      show = null;
      season = null;
    }
    if (!show || show.ids.tmdb !== r.tv_tmdb_id) {
      show = { ids: { tmdb: r.tv_tmdb_id }, seasons: [] };
      batch.shows.push(show);
      season = null;
    }
    if (!season || season.number !== r.season_number) {
      season = { number: r.season_number, episodes: [] };
      show.seasons.push(season);
    }
    season.episodes.push({ number: r.episode_number, watched_at: r.watched_at });
    batch.episodeCount++;
  }
  return batches;
}

/**
 * Last line of defence before anything is POSTed to /sync/history: a show object without explicit
 * episodes means "mark the WHOLE show watched" on Trakt, which this app must never do.
 */
export function assertEpisodeOnlyPayload(payload: { shows: PushShow[] }): void {
  for (const s of payload.shows) {
    const ok =
      typeof s.ids?.tmdb === "number" &&
      Array.isArray(s.seasons) &&
      s.seasons.length > 0 &&
      s.seasons.every(
        (x) => Array.isArray(x.episodes) && x.episodes.length > 0 && x.episodes.every((e) => !!e.watched_at),
      );
    if (!ok) throw new Error("Refusing to push a show to Trakt without explicit episodes");
  }
}

// ---------- IMPORT ----------

export async function* runImport(userId: string, token: string): AsyncGenerator<ProgressEvent> {
  const summary = {
    history: 0,
    episodes: 0,
    watchlist: 0,
    ratings: 0,
    ratingsUnmatched: 0,
    lists: 0,
    listItems: 0,
  };
  try {
    // 1. Watched history -> library rows (+ episode progress for shows)
    yield { type: "phase", phase: "history", total: 0 };
    const moviesHist = await traktGetAll<{ last_watched_at?: string | null; movie: TraktMovie }>(
      "/sync/watched/movies",
      token,
    );
    const showsHist = await traktGetAll<WatchedShow>("/sync/watched/shows?extended=full", token);
    const episodeHist = await traktGetAll<HistoryEpisode>("/sync/history/episodes", token, { limit: 250 });

    const { perShow, stats } = collectEpisodes(showsHist.items, episodeHist.items);

    const movieRows: ImportLibraryRow[] = moviesHist.items
      .filter((r) => r.movie?.ids?.tmdb)
      .map((r) => ({
        media_type: "movie" as const,
        tmdb_id: r.movie.ids.tmdb!,
        title: r.movie.title,
        release_date: r.movie.year ? String(r.movie.year) : null,
        status: "completed" as const,
        watched_at: r.last_watched_at ?? null,
      }));
    const moviesWithoutDate = movieRows.filter((m) => !m.watched_at).length;

    const showRows: ImportLibraryRow[] = [];
    const episodeRows: ImportEpisodeRow[] = [];
    const statusCounts: Record<string, number> = { completed: 0, watching: 0, plan_to_watch: 0 };
    const overAired: string[] = [];
    let airedUnknown = 0;
    let showsNoTmdb = 0;
    let showsNoEpisodes = 0;
    let episodesNoTmdb = 0;
    for (const it of showsHist.items) {
      const tmdb = it.show?.ids?.tmdb;
      const trakt = it.show?.ids?.trakt;
      const eps = trakt != null ? perShow.get(trakt) : undefined;
      if (!tmdb) {
        showsNoTmdb++;
        episodesNoTmdb += eps?.size ?? 0;
        continue;
      }
      const watched = eps?.size ?? 0;
      if (watched === 0) showsNoEpisodes++;
      const d = decideShowStatus(watched, it.show.aired_episodes);
      statusCounts[d.status]++;
      if (d.airedUnknown) airedUnknown++;
      if (d.overAired) overAired.push(`${it.show.title} (${watched}/${it.show.aired_episodes})`);
      showRows.push({
        media_type: "tv",
        tmdb_id: tmdb,
        title: it.show.title,
        release_date: it.show.year ? String(it.show.year) : null,
        status: d.status,
      });
      for (const e of eps?.values() ?? []) {
        episodeRows.push({
          tv_tmdb_id: tmdb,
          season_number: e.season,
          episode_number: e.episode,
          watched_at: e.watchedAt,
        });
      }
    }

    const histRows = [...movieRows, ...showRows];
    const histTotal = moviesHist.items.length + showsHist.items.length;
    yield { type: "phase", phase: "history", total: histTotal };
    let i = 0;
    const hist = { inserted: 0, advanced: 0, unchanged: 0, watchedAtSet: 0 };
    for (const batch of chunk(histRows, 100)) {
      const c = importLibraryRows(userId, batch);
      hist.inserted += c.inserted;
      hist.advanced += c.advanced;
      hist.unchanged += c.unchanged;
      hist.watchedAtSet += c.watchedAtSet;
      i += batch.length;
      summary.history = i;
      yield { type: "progress", phase: "history", current: i, total: histTotal };
    }
    log(
      `history: movies ${pagedNote(moviesHist)}, shows ${pagedNote(showsHist)}; ` +
        `library inserted=${hist.inserted} advanced=${hist.advanced} unchanged=${hist.unchanged} ` +
        `skipped=${histTotal - histRows.length} (no tmdb id); ` +
        `movie watched dates: set on existing=${hist.watchedAtSet}, trakt gave none for ${moviesWithoutDate}; ` +
        `new-show statuses: completed=${statusCounts.completed} watching=${statusCounts.watching} ` +
        `plan_to_watch=${statusCounts.plan_to_watch}`,
    );
    if (overAired.length) {
      log(
        `history: WARNING ${overAired.length} show(s) have more watched than aired episodes ` +
          `(marked completed): ${overAired.slice(0, 10).join("; ")}${overAired.length > 10 ? "; ..." : ""}`,
      );
    }
    if (airedUnknown) {
      log(`history: WARNING ${airedUnknown} show(s) have no aired_episodes from Trakt (marked watching, not completed)`);
    }
    if (showsNoEpisodes) {
      log(`history: ${showsNoEpisodes} show(s) have no countable watched episodes in the history (only specials, or none): plan_to_watch`);
    }

    // 1b. Episode progress
    yield { type: "phase", phase: "episodes", total: episodeRows.length };
    let ep = 0;
    const epCounts = { inserted: 0, existing: 0 };
    for (const batch of chunk(episodeRows, 500)) {
      const c = importEpisodeProgress(userId, batch);
      epCounts.inserted += c.inserted;
      epCounts.existing += c.existing;
      ep += batch.length;
      summary.episodes = ep;
      yield { type: "progress", phase: "episodes", current: ep, total: episodeRows.length };
    }
    const reported = episodeHist.reportedTotal;
    const totalNote =
      reported === null
        ? "Trakt reported no total"
        : reported === episodeHist.items.length
          ? `matches Trakt's reported total of ${reported}`
          : `MISMATCH: Trakt reported ${reported}`;
    log(
      `episodes: plays fetched=${episodeHist.items.length} in ${episodeHist.pages} page${episodeHist.pages === 1 ? "" : "s"} (${totalNote})`,
    );
    const accounted = stats.counted + stats.repeats + stats.specials + stats.unknownShow + stats.malformed;
    log(
      `episodes: counted ${stats.counted} distinct watched episodes (all-time; reset_at ignored) + ` +
        `repeat plays collapsed=${stats.repeats} + specials ignored=${stats.specials} + ` +
        `unknown-show=${stats.unknownShow} + malformed=${stats.malformed} = ${accounted} of ${stats.plays} plays` +
        (accounted === stats.plays ? " (all accounted for)" : " (WARNING: ACCOUNTING MISMATCH)"),
    );
    if (stats.showsWithReset) {
      log(
        `episodes: ${stats.showsWithReset} show(s) have a reset_at on Trakt; ${stats.playsBeforeReset} play(s) predate it and are counted`,
      );
    }
    log(
      `episodes: inserted=${epCounts.inserted} already-present=${epCounts.existing} ` +
        `skipped=${episodesNoTmdb} (show has no tmdb id)`,
    );

    // 2. Watchlist -> plan_to_watch (existing rows are never moved backward, so they stay as they are)
    yield { type: "phase", phase: "watchlist", total: 0 };
    const watchlist = await traktGetAll<MediaItemEntry>("/sync/watchlist", token);
    const wRows = watchlist.items
      .map((it): ImportLibraryRow | null => {
        const m = it.type === "movie" ? it.movie : it.show;
        if (!m?.ids?.tmdb) return null;
        return {
          media_type: it.type === "movie" ? "movie" : "tv",
          tmdb_id: m.ids.tmdb,
          title: m.title,
          release_date: m.year ? String(m.year) : null,
          status: "plan_to_watch",
        };
      })
      .filter((x): x is ImportLibraryRow => !!x);
    yield { type: "phase", phase: "watchlist", total: wRows.length };
    let j = 0;
    let wInserted = 0;
    let wExisting = 0;
    for (const batch of chunk(wRows, 100)) {
      const c = importLibraryRows(userId, batch);
      wInserted += c.inserted;
      wExisting += c.advanced + c.unchanged;
      j += batch.length;
      summary.watchlist = j;
      yield { type: "progress", phase: "watchlist", current: j, total: wRows.length };
    }
    log(
      `watchlist: ${pagedNote(watchlist)}; inserted=${wInserted} ` +
        `already-in-library=${wExisting} skipped=${watchlist.items.length - wRows.length} (no tmdb id)`,
    );

    // 3. Ratings (an UPDATE on titles already in the library; runs after history + watchlist
    //    so that everything the user has watched or queued exists to be rated)
    yield { type: "phase", phase: "ratings", total: 0 };
    const ratings = await traktGetAll<{
      rating: number;
      type: "movie" | "show";
      movie?: TraktMovie;
      show?: TraktShow;
    }>("/sync/ratings", token);
    const rRows = ratings.items
      .map((r) => {
        const m = r.type === "movie" ? r.movie : r.show;
        if (!m?.ids?.tmdb) return null;
        return {
          media_type: (r.type === "movie" ? "movie" : "tv") as "movie" | "tv",
          tmdb_id: m.ids.tmdb,
          title: m.title,
          rating: r.rating,
        };
      })
      .filter((x): x is NonNullable<typeof x> => !!x);
    yield { type: "phase", phase: "ratings", total: rRows.length };
    let k = 0;
    let rMatched = 0;
    const unmatched: typeof rRows = [];
    for (const row of rRows) {
      if (setLibraryRating(userId, row.media_type, row.tmdb_id, row.rating)) rMatched++;
      else unmatched.push(row);
      k += 1;
      summary.ratings = rMatched;
      summary.ratingsUnmatched = unmatched.length;
      if (k % 10 === 0 || k === rRows.length) {
        yield { type: "progress", phase: "ratings", current: k, total: rRows.length };
      }
    }
    log(
      `ratings: ${pagedNote(ratings)}; matched=${rMatched} ` +
        `unmatched=${unmatched.length} (rated but in neither history nor watchlist; not inserted) ` +
        `skipped=${ratings.items.length - rRows.length} (no tmdb id)`,
    );
    if (unmatched.length) {
      const shown = unmatched
        .slice(0, 25)
        .map((u) => `${u.media_type}:${u.tmdb_id} "${u.title}" (${u.rating}/10)`)
        .join(", ");
      log(`ratings: unmatched titles${unmatched.length > 25 ? ` (first 25 of ${unmatched.length})` : ""}: ${shown}`);
    }

    // 4. Personal lists
    yield { type: "phase", phase: "lists", total: 0 };
    const lists = await traktGetAll<{
      ids: { trakt: number; slug: string };
      name: string;
      description: string | null;
    }>("/users/me/lists", token);
    yield { type: "phase", phase: "lists", total: lists.items.length };
    let li = 0;
    let lItemsFetched = 0;
    let lItemsInserted = 0;
    let lItemsDuplicate = 0;
    let lItemsNoTmdb = 0;
    for (const l of lists.items) {
      let listId = findListIdByName(userId, l.name);
      if (!listId) {
        listId = createList(userId, l.name, l.description).id;
        summary.lists += 1;
      }
      const items = await traktGetAll<MediaItemEntry>(`/users/me/lists/${l.ids.slug}/items`, token);
      if (items.reportedTotal !== null && items.reportedTotal !== items.items.length) {
        log(`list "${l.name}": WARNING fetched ${items.items.length}, Trakt reported ${items.reportedTotal}`);
      }
      const itemRows = items.items
        .map((it) => {
          const m = it.type === "movie" ? it.movie : it.show;
          if (!m?.ids?.tmdb) return null;
          return {
            media_type: (it.type === "movie" ? "movie" : "tv") as "movie" | "tv",
            tmdb_id: m.ids.tmdb,
            title: m.title,
            release_date: m.year ? String(m.year) : null,
          };
        })
        .filter((x): x is NonNullable<typeof x> => !!x);
      lItemsFetched += items.items.length;
      lItemsNoTmdb += items.items.length - itemRows.length;
      for (const batch of chunk(itemRows, 100)) {
        const c = importListItems(userId, listId, batch);
        lItemsInserted += c.inserted;
        lItemsDuplicate += c.duplicates;
        summary.listItems += c.inserted;
      }
      li += 1;
      yield { type: "progress", phase: "lists", current: li, total: lists.items.length };
    }
    log(
      `lists: ${lists.items.length} lists (${summary.lists} newly created); items fetched=${lItemsFetched} ` +
        `inserted=${lItemsInserted} already-in-list=${lItemsDuplicate} skipped=${lItemsNoTmdb} (no tmdb id)`,
    );

    yield { type: "done", summary };
  } catch (e) {
    logError("Trakt import failed", e);
    yield { type: "error", message: redactText(e instanceof Error ? e.message : "Import failed") };
  }
}

// ---------- SYNC (push library to Trakt) ----------

export async function* runSync(userId: string, token: string): AsyncGenerator<ProgressEvent> {
  const summary = { completed: 0, episodes: 0, watchlist: 0, ratings: 0 };
  try {
    const rows = listLibraryForSync(userId);

    const completedMovies = rows.filter((r) => r.status === "completed" && r.media_type === "movie");
    const planMovies = rows.filter((r) => r.status === "plan_to_watch" && r.media_type === "movie");
    const planShows = rows.filter((r) => r.status === "plan_to_watch" && r.media_type === "tv");
    const ratedMovies = rows.filter((r) => r.rating != null && r.media_type === "movie");
    const ratedShows = rows.filter((r) => r.rating != null && r.media_type === "tv");

    // History: completed movies. Shows are NEVER pushed as a whole-show completion (that would
    // mark every episode watched on Trakt); their watched episodes go out one by one below.
    yield { type: "phase", phase: "history", total: completedMovies.length };
    let h = 0;
    for (const batch of chunk(completedMovies, 100)) {
      await traktPost("/sync/history", { movies: batch.map((m) => ({ ids: { tmdb: m.tmdb_id } })) }, token);
      h += batch.length;
      summary.completed = h;
      yield { type: "progress", phase: "history", current: h, total: completedMovies.length };
    }

    // Episodes: only what episode_progress says was watched, each with its watched_at so that
    // plays Trakt already has are recognised as duplicates instead of being added again.
    const episodeBatches = buildEpisodePushBatches(listEpisodesForSync(userId));
    const episodeTotal = episodeBatches.reduce((n, b) => n + b.episodeCount, 0);
    yield { type: "phase", phase: "episodes", total: episodeTotal };
    let e = 0;
    for (const batch of episodeBatches) {
      assertEpisodeOnlyPayload(batch);
      await traktPost("/sync/history", { shows: batch.shows }, token);
      e += batch.episodeCount;
      summary.episodes = e;
      yield { type: "progress", phase: "episodes", current: e, total: episodeTotal };
    }

    // Watchlist
    const wTotal = planMovies.length + planShows.length;
    yield { type: "phase", phase: "watchlist", total: wTotal };
    let w = 0;
    for (const batch of chunk(planMovies, 100)) {
      await traktPost("/sync/watchlist", { movies: batch.map((m) => ({ ids: { tmdb: m.tmdb_id } })) }, token);
      w += batch.length;
      summary.watchlist = w;
      yield { type: "progress", phase: "watchlist", current: w, total: wTotal };
    }
    for (const batch of chunk(planShows, 100)) {
      await traktPost("/sync/watchlist", { shows: batch.map((s) => ({ ids: { tmdb: s.tmdb_id } })) }, token);
      w += batch.length;
      summary.watchlist = w;
      yield { type: "progress", phase: "watchlist", current: w, total: wTotal };
    }

    // Ratings
    const rTotal = ratedMovies.length + ratedShows.length;
    yield { type: "phase", phase: "ratings", total: rTotal };
    let r = 0;
    for (const batch of chunk(ratedMovies, 100)) {
      await traktPost(
        "/sync/ratings",
        { movies: batch.map((m) => ({ ids: { tmdb: m.tmdb_id }, rating: m.rating })) },
        token,
      );
      r += batch.length;
      summary.ratings = r;
      yield { type: "progress", phase: "ratings", current: r, total: rTotal };
    }
    for (const batch of chunk(ratedShows, 100)) {
      await traktPost(
        "/sync/ratings",
        { shows: batch.map((s) => ({ ids: { tmdb: s.tmdb_id }, rating: s.rating })) },
        token,
      );
      r += batch.length;
      summary.ratings = r;
      yield { type: "progress", phase: "ratings", current: r, total: rTotal };
    }

    log(
      `sync: movies completed=${summary.completed} episodes=${summary.episodes} ` +
        `watchlist=${summary.watchlist} ratings=${summary.ratings}`,
    );
    yield { type: "done", summary };
  } catch (e) {
    logError("Trakt sync failed", e);
    yield { type: "error", message: redactText(e instanceof Error ? e.message : "Sync failed") };
  }
}
