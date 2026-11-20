/**
 * The list of changes made inside this app that have not been sent to Trakt / WeTrakr yet.
 *
 * Sync sends ONLY these rows: it never compares or pushes the whole library. A row is written
 * when the user does something in the app (the tracked* functions below, called by the server
 * functions behind the buttons). Imports and restores call the plain library functions, so what
 * they bring in is never queued to be sent back.
 *
 * Every connected service (Trakt, WeTrakr) has its own waiting list: a change is queued once for
 * each service that is connected when it is made, so both get it and one being down does not hold
 * up the other. A service connected later does not get older changes.
 *
 * One row per service and subject, and opposite changes cancel out, so marking something and undoing it
 * before a sync leaves nothing to send:
 *  - watch      one row per play (title + date). Shows are only ever queued as single episodes.
 *  - unwatch    "remove every play of this movie / episode". Dropped again if the plays it would
 *               remove were never sent in the first place.
 *  - watchlist  value 1 = add, 0 = remove.
 *  - rating     value = the rating, NULL = remove; prev_value = the rating before the first
 *               unsent change, so going back to it cancels the row.
 *  - unplay     one play of a movie / episode removed (the title stays watched).
 *  - favorite   value 1 = add, 0 = remove.
 *  - status     a show moved into or out of Dropped / On hold: status = 'dropped' | 'on_hold' |
 *               'active', prev_status = what it was before the first unsent change.
 *  - list       a list was created or renamed (value 1: list_name = its name now, prev_name = its
 *               name on the services, NULL when it is new) or deleted (value 0). Lists are matched
 *               to the services' lists by name, the same way the imports match them.
 *  - list_item  a title added to (value 1) or taken out of (value 0) a list.
 */
import { getDb, newId, transaction } from "./db.ts";
import * as lib from "./library.server.ts";
import * as lists from "./lists.server.ts";
import * as plays from "./plays.server.ts";
import type { LibraryItem, ListRow, MediaKind, PlayRow } from "./types.ts";

export type SyncChangeKind =
  | "watch" | "unwatch" | "unplay" | "watchlist" | "rating" | "favorite" | "status" | "list" | "list_item";
export type ShowStatus = "dropped" | "on_hold" | "active";

export type SyncService = "trakt" | "wetrakr";
export const SYNC_SERVICES: SyncService[] = ["trakt", "wetrakr"];

export type SyncChange = {
  id: string;
  service: SyncService;
  subject: string;
  kind: SyncChangeKind;
  media_type: MediaKind;
  tmdb_id: number;
  season_number: number | null;
  episode_number: number | null;
  title: string;
  watched_at: string | null;
  first_watch: number;
  value: number | null;
  prev_value: number | null;
  status: ShowStatus | null;
  prev_status: ShowStatus | null;
  list_id: string | null;
  list_name: string | null;
  prev_name: string | null;
  list_description: string | null;
  created_at: string;
};

type Target = {
  mediaType: MediaKind;
  tmdbId: number;
  /** Both set for an episode, both null for a movie. A show as a whole is never a target for watch/unwatch. */
  season?: number | null;
  episode?: number | null;
  title: string;
};

/** The services that are connected right now. */
export function connectedServices(userId: string): SyncService[] {
  const db = getDb();
  const has = (table: string) => !!db.prepare(`SELECT 1 FROM ${table} WHERE user_id = ?`).get(userId);
  return SYNC_SERVICES.filter((s) => has(s === "trakt" ? "trakt_connections" : "wetrakr_connections"));
}

// The record* functions below work on one service's list at a time: eachService runs them once
// per connected service. Everything here is synchronous, so the variable cannot be interleaved.
let current: SyncService = "trakt";
function eachService(userId: string, fn: () => void): void {
  for (const s of connectedServices(userId)) {
    current = s;
    fn();
  }
}

function isoOrNull(v: string | null | undefined): string | null {
  const t = v ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function itemKey(t: Target): string {
  return t.season != null && t.episode != null
    ? `${t.mediaType}:${t.tmdbId}:${t.season}:${t.episode}`
    : `${t.mediaType}:${t.tmdbId}`;
}

function insert(userId: string, t: Target, subject: string, kind: SyncChangeKind, extra: Partial<SyncChange>): void {
  getDb()
    .prepare(
      `INSERT INTO sync_changes
         (id, user_id, service, subject, kind, media_type, tmdb_id, season_number, episode_number, title,
          watched_at, first_watch, value, prev_value, status, prev_status, list_id, list_name, prev_name,
          list_description)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(user_id, service, subject) DO NOTHING`,
    )
    .run(
      newId(), userId, current, subject, kind, t.mediaType, t.tmdbId, t.season ?? null, t.episode ?? null, t.title,
      extra.watched_at ?? null, extra.first_watch ?? 0, extra.value ?? null, extra.prev_value ?? null,
      extra.status ?? null, extra.prev_status ?? null, extra.list_id ?? null, extra.list_name ?? null,
      extra.prev_name ?? null, extra.list_description ?? null,
    );
}

function findBySubject(userId: string, subject: string): SyncChange | undefined {
  return getDb().prepare(`SELECT * FROM sync_changes WHERE user_id = ? AND service = ? AND subject = ?`).get(userId, current, subject) as
    | SyncChange
    | undefined;
}

function deleteById(id: string): void {
  getDb().prepare(`DELETE FROM sync_changes WHERE id = ?`).run(id);
}

/** A play of a movie or of one episode, on a date. `firstWatch`: it was not watched here before. */
function recordWatch(userId: string, t: Target, watchedAt: string | null | undefined, firstWatch: boolean): void {
  if (t.mediaType === "tv" && (t.season == null || t.episode == null)) return; // never a whole show
  const at = isoOrNull(watchedAt) ?? new Date().toISOString();
  insert(userId, t, `watch:${itemKey(t)}:${at}`, "watch", { watched_at: at, first_watch: firstWatch ? 1 : 0 });
}

/** The movie / episode is no longer watched here. */
function recordUnwatch(userId: string, t: Target): void {
  if (t.mediaType === "tv" && (t.season == null || t.episode == null)) return; // never a whole show
  const db = getDb();
  const pendingWatches = db
    .prepare(
      `SELECT id, first_watch FROM sync_changes
       WHERE user_id = ? AND service = ? AND kind = 'watch' AND media_type = ? AND tmdb_id = ?
         AND season_number IS ? AND episode_number IS ?`,
    )
    .all(userId, current, t.mediaType, t.tmdbId, t.season ?? null, t.episode ?? null) as { id: string; first_watch: number }[];
  for (const w of pendingWatches) deleteById(w.id);
  // Watched and un-watched again between two syncs: the service never heard of it, nothing to remove.
  if (pendingWatches.some((w) => w.first_watch === 1)) return;
  insert(userId, t, `unwatch:${itemKey(t)}`, "unwatch", {});
}

function recordWatchlist(userId: string, t: Target, add: boolean): void {
  const subject = `watchlist:${t.mediaType}:${t.tmdbId}`;
  const pending = findBySubject(userId, subject);
  if (pending) {
    if ((pending.value === 1) !== add) deleteById(pending.id); // undone before it was sent
    return;
  }
  insert(userId, t, subject, "watchlist", { value: add ? 1 : 0 });
}

function dropPendingWatchlistAdd(userId: string, t: Target): void {
  const pending = findBySubject(userId, `watchlist:${t.mediaType}:${t.tmdbId}`);
  if (pending?.value === 1) deleteById(pending.id);
}

/** A rating set, changed or removed: a movie, a show, or one episode (t.season / t.episode set). */
function recordRating(userId: string, t: Target, rating: number | null, before: number | null): void {
  const subject = `rating:${itemKey(t)}`;
  const pending = findBySubject(userId, subject);
  if (!pending) {
    insert(userId, t, subject, "rating", { value: rating, prev_value: before });
    return;
  }
  if (rating === pending.prev_value) deleteById(pending.id); // back to what it was
  else getDb().prepare(`UPDATE sync_changes SET value = ? WHERE id = ?`).run(rating, pending.id);
}

/** On / off things (watchlist, favourite, a title in a list): a change and its undo cancel out. */
function recordToggle(userId: string, t: Target, kind: "favorite" | "list_item", subject: string, on: boolean, extra: Partial<SyncChange> = {}): void {
  const pending = findBySubject(userId, subject);
  if (pending) {
    if ((pending.value === 1) !== on) deleteById(pending.id);
    return;
  }
  insert(userId, t, subject, kind, { value: on ? 1 : 0, ...extra });
}

function showStatus(x: LibraryItem | null): ShowStatus {
  return x?.status === "dropped" ? "dropped" : x?.status === "on_hold" ? "on_hold" : "active";
}

function recordStatus(userId: string, t: Target, now: ShowStatus, before: ShowStatus): void {
  const subject = `status:${t.mediaType}:${t.tmdbId}`;
  const pending = findBySubject(userId, subject);
  if (!pending) {
    insert(userId, t, subject, "status", { status: now, prev_status: before });
    return;
  }
  if (now === pending.prev_status) deleteById(pending.id);
  else getDb().prepare(`UPDATE sync_changes SET status = ? WHERE id = ?`).run(now, pending.id);
}

const onWatchlist = (x: LibraryItem | null) => !!x && (x.watchlist || x.status === "plan_to_watch");
const movieWatched = (x: LibraryItem | null) => !!x && x.media_type === "movie" && x.status === "completed";

/** Queue, for every connected service, whatever differs between a title's library row before and after a change. */
function recordLibraryDiff(userId: string, before: LibraryItem | null, after: LibraryItem | null): void {
  eachService(userId, () => recordLibraryDiffOnce(userId, before, after));
}

function recordLibraryDiffOnce(userId: string, before: LibraryItem | null, after: LibraryItem | null): void {
  const row = after ?? before;
  if (!row) return;
  const t: Target = { mediaType: row.media_type, tmdbId: row.tmdb_id, title: row.title };

  const becameWatched = !movieWatched(before) && movieWatched(after);
  if (becameWatched) {
    recordWatch(userId, t, after!.watched_at, true);
  } else if (movieWatched(before) && movieWatched(after)) {
    // A rewatch logged with a new date.
    const at = isoOrNull(after!.watched_at);
    if (at && at !== isoOrNull(before!.watched_at)) recordWatch(userId, t, at, false);
  } else if (movieWatched(before) && !movieWatched(after)) {
    recordUnwatch(userId, t);
  }

  const wasListed = onWatchlist(before);
  const isListed = onWatchlist(after);
  if (wasListed !== isListed) {
    // Watching a movie takes it off the watchlist on both services by itself: nothing to send for that.
    if (becameWatched) dropPendingWatchlistAdd(userId, t);
    else recordWatchlist(userId, t, isListed);
  }

  const ratingBefore = before?.rating ?? null;
  const ratingAfter = after?.rating ?? null;
  if (ratingBefore !== ratingAfter) recordRating(userId, t, ratingAfter, ratingBefore);

  if (!!before?.favorite !== !!after?.favorite) {
    recordToggle(userId, t, "favorite", `favorite:${t.mediaType}:${t.tmdbId}`, !!after?.favorite);
  }

  // A show moved into or out of Dropped / On hold. Leaving the library is not a status change.
  if (row.media_type === "tv" && before && after) {
    const was = showStatus(before);
    const now = showStatus(after);
    if (was !== now) recordStatus(userId, t, now, was);
  }
}

// ---------- the tracked versions of the actions behind the app's buttons ----------

/**
 * Watches brought in from Trakt (and older ones) exist only as the date on the movie's library row or on the
 * episode's progress row, with no play row: the plays list shows that date as a stand-in. Before another play is
 * added, or that date is replaced by a rewatch, write it as a real play so the earlier watch is kept. Not queued
 * for Sync: the services already have it. Skipped when it is the same moment as the play being added (the first
 * watch, saved by both buttons' calls).
 */
function keepStandInPlay(
  userId: string,
  f: plays.PlayFilter,
  watchedAt: string | null | undefined,
  rating: number | null | undefined,
  newAt: string | null | undefined,
): void {
  const at = isoOrNull(watchedAt);
  if (!at || at === isoOrNull(newAt)) return;
  if (plays.listPlays(userId, f).length) return;
  plays.addPlay(userId, { ...f, watchedAt: at, rating: rating ?? null });
}

export function trackedUpsertLibraryItem(userId: string, d: lib.UpsertLibraryInput): LibraryItem {
  return transaction(() => {
    const before = lib.getLibraryItem(userId, d.mediaType, d.tmdbId);
    if (movieWatched(before) && d.watchedAt) {
      keepStandInPlay(userId, { mediaType: "movie", tmdbId: d.tmdbId }, before!.watched_at, before!.rating, d.watchedAt);
    }
    const after = lib.upsertLibraryItem(userId, d);
    recordLibraryDiff(userId, before, after);
    return after;
  });
}

export function trackedRemoveLibraryItem(userId: string, mediaType: MediaKind, tmdbId: number): void {
  transaction(() => {
    const before = lib.getLibraryItem(userId, mediaType, tmdbId);
    lib.removeLibraryItem(userId, mediaType, tmdbId);
    recordLibraryDiff(userId, before, null);
  });
}

function showTitle(userId: string, tvTmdbId: number): string {
  return lib.getLibraryItem(userId, "tv", tvTmdbId)?.title ?? `Show ${tvTmdbId}`;
}

function episodeRow(userId: string, tvTmdbId: number, season: number, episode: number) {
  return getDb()
    .prepare(
      `SELECT watched_at, rating FROM episode_progress
       WHERE user_id = ? AND tv_tmdb_id = ? AND season_number = ? AND episode_number = ?`,
    )
    .get(userId, tvTmdbId, season, episode) as { watched_at: string; rating: number | null } | undefined;
}

export function trackedMarkEpisodeWatched(
  userId: string,
  d: { tvTmdbId: number; seasonNumber: number; episodeNumber: number; watchedAt?: string; rating?: number | null },
): void {
  transaction(() => {
    const before = episodeRow(userId, d.tvTmdbId, d.seasonNumber, d.episodeNumber);
    lib.markEpisodeWatched(userId, d);
    const after = episodeRow(userId, d.tvTmdbId, d.seasonNumber, d.episodeNumber);
    if (!after) return;
    const t: Target = {
      mediaType: "tv", tmdbId: d.tvTmdbId, season: d.seasonNumber, episode: d.episodeNumber,
      title: showTitle(userId, d.tvTmdbId),
    };
    eachService(userId, () => {
      if (!before) recordWatch(userId, t, after.watched_at, true);
      else if (isoOrNull(after.watched_at) !== isoOrNull(before.watched_at)) recordWatch(userId, t, after.watched_at, false);
      if ((before?.rating ?? null) !== (after.rating ?? null)) recordRating(userId, t, after.rating ?? null, before?.rating ?? null);
    });
  });
}

/**
 * A rewatch of an episode given a rating: the episode's rating becomes that one (as a movie's does), and the change
 * is queued for Sync. Called before the play is saved.
 */
function rateEpisodeFromPlay(userId: string, t: Target, rating: number | null | undefined): void {
  if (rating == null || t.season == null || t.episode == null) return;
  const ep = episodeRow(userId, t.tmdbId, t.season, t.episode);
  if (!ep || ep.rating === rating) return;
  getDb()
    .prepare(`UPDATE episode_progress SET rating = ? WHERE user_id = ? AND tv_tmdb_id = ? AND season_number = ? AND episode_number = ?`)
    .run(rating, userId, t.tmdbId, t.season, t.episode);
  eachService(userId, () => recordRating(userId, t, rating, ep.rating));
}

export function trackedUnmarkEpisode(userId: string, tvTmdbId: number, season: number, episode: number): void {
  transaction(() => {
    const before = episodeRow(userId, tvTmdbId, season, episode);
    lib.unmarkEpisode(userId, tvTmdbId, season, episode);
    if (before) {
      const t: Target = { mediaType: "tv", tmdbId: tvTmdbId, season, episode, title: showTitle(userId, tvTmdbId) };
      eachService(userId, () => {
        recordUnwatch(userId, t);
        if (before.rating != null) recordRating(userId, t, null, before.rating); // the rating went with the tick
      });
    }
  });
}

export function trackedMarkEpisodes(
  userId: string,
  d: { tvTmdbId: number; seasonNumber: number; episodeNumbers: number[]; watchedAt?: string },
): number {
  return transaction(() => {
    for (const n of d.episodeNumbers) {
      // Episodes already watched keep their date and are not queued again.
      if (episodeRow(userId, d.tvTmdbId, d.seasonNumber, n)) continue;
      trackedMarkEpisodeWatched(userId, {
        tvTmdbId: d.tvTmdbId, seasonNumber: d.seasonNumber, episodeNumber: n, watchedAt: d.watchedAt,
      });
    }
    return d.episodeNumbers.length;
  });
}

export function trackedAddPlay(
  userId: string,
  d: plays.PlayFilter & { watchedAt: string; rating?: number | null },
): PlayRow {
  return transaction(() => {
    if (d.mediaType === "movie") {
      const item = lib.getLibraryItem(userId, "movie", d.tmdbId);
      const t: Target = { mediaType: "movie", tmdbId: d.tmdbId, title: item?.title ?? `Movie ${d.tmdbId}` };
      if (movieWatched(item)) {
        keepStandInPlay(userId, { mediaType: "movie", tmdbId: d.tmdbId }, item!.watched_at, item!.rating, d.watchedAt);
      }
      eachService(userId, () => recordWatch(userId, t, d.watchedAt, !movieWatched(item)));
    } else if (d.seasonNumber != null && d.episodeNumber != null) {
      const t: Target = {
        mediaType: "tv", tmdbId: d.tmdbId, season: d.seasonNumber, episode: d.episodeNumber,
        title: showTitle(userId, d.tmdbId),
      };
      const ep = episodeRow(userId, d.tmdbId, d.seasonNumber, d.episodeNumber);
      if (ep) {
        const f = { mediaType: "tv" as const, tmdbId: d.tmdbId, seasonNumber: d.seasonNumber, episodeNumber: d.episodeNumber };
        keepStandInPlay(userId, f, ep.watched_at, ep.rating, d.watchedAt);
      }
      eachService(userId, () => recordWatch(userId, t, d.watchedAt, !ep));
      rateEpisodeFromPlay(userId, t, d.rating);
    }
    const row = plays.addPlay(userId, d);
    syncWatchedDate(userId, d);
    return row;
  });
}

/**
 * A movie's / episode's watched date (on its library row / progress row) is its latest play. After a play is added
 * or removed, move that date to the latest play left. Not queued for Sync: the services work it out from the plays.
 * Nothing changes when it is not watched here, or has no plays (watches with only a date, from Trakt or "mark
 * earlier episodes", keep their date).
 */
function syncWatchedDate(userId: string, f: plays.PlayFilter): void {
  let latest: string | null = null;
  for (const p of plays.listPlays(userId, f)) {
    if (!latest || Date.parse(p.watched_at) > Date.parse(latest)) latest = p.watched_at;
  }
  if (!latest) return;
  const db = getDb();
  if (f.mediaType === "movie") {
    const item = lib.getLibraryItem(userId, "movie", f.tmdbId);
    if (!movieWatched(item) || isoOrNull(item!.watched_at) === isoOrNull(latest)) return;
    db.prepare(`UPDATE library_items SET watched_at = ? WHERE user_id = ? AND media_type = 'movie' AND tmdb_id = ?`)
      .run(latest, userId, f.tmdbId);
  } else if (f.seasonNumber != null && f.episodeNumber != null) {
    const ep = episodeRow(userId, f.tmdbId, f.seasonNumber, f.episodeNumber);
    if (!ep || isoOrNull(ep.watched_at) === isoOrNull(latest)) return;
    db.prepare(
      `UPDATE episode_progress SET watched_at = ?
       WHERE user_id = ? AND tv_tmdb_id = ? AND season_number = ? AND episode_number = ?`,
    ).run(latest, userId, f.tmdbId, f.seasonNumber, f.episodeNumber);
  }
}

/** An episode is no longer watched: its plays and its tick go, and the services are told to remove every play of it. */
function unwatchEpisode(userId: string, tvTmdbId: number, season: number, episode: number): void {
  const f = { mediaType: "tv" as const, tmdbId: tvTmdbId, seasonNumber: season, episodeNumber: episode };
  const hadPlays = plays.listPlays(userId, f).length > 0;
  const row = episodeRow(userId, tvTmdbId, season, episode);
  plays.removeAllPlays(userId, f);
  lib.unmarkEpisode(userId, tvTmdbId, season, episode);
  if (!hadPlays && !row) return;
  const t: Target = { mediaType: "tv", tmdbId: tvTmdbId, season, episode, title: showTitle(userId, tvTmdbId) };
  eachService(userId, () => {
    recordUnwatch(userId, t);
    // Its rating went with it, as a movie's does when it leaves the library.
    if (row?.rating != null) recordRating(userId, t, null, row.rating);
  });
}

/** A movie is no longer watched: its plays go and it leaves the library, as "Remove all plays" has always done. */
function unwatchMovie(userId: string, tmdbId: number): void {
  plays.removeAllPlays(userId, { mediaType: "movie", tmdbId });
  trackedRemoveLibraryItem(userId, "movie", tmdbId);
}

/**
 * Removing one play. When it was the last one, the movie / episode is no longer watched (exactly like "Remove all
 * plays"): before, the play went but the tick and its date stayed, so the watch history showed the same date again.
 * Otherwise the play is un-queued if it had not been sent yet (or removed on the services), and the watched date
 * moves to the latest play left.
 */
export function trackedRemovePlay(userId: string, id: string): void {
  transaction(() => {
    const p = getDb().prepare(`SELECT * FROM plays WHERE id = ? AND user_id = ?`).get(id, userId) as PlayRow | undefined;
    if (!p) return;
    const isEpisode = p.season_number != null && p.episode_number != null;
    const f: plays.PlayFilter = {
      mediaType: p.media_type, tmdbId: p.tmdb_id, seasonNumber: p.season_number, episodeNumber: p.episode_number,
    };
    plays.removePlay(userId, id);

    if (plays.listPlays(userId, f).length === 0) {
      if (p.media_type === "movie" && movieWatched(lib.getLibraryItem(userId, "movie", p.tmdb_id))) {
        unwatchMovie(userId, p.tmdb_id);
        return;
      }
      if (isEpisode && episodeRow(userId, p.tmdb_id, p.season_number!, p.episode_number!)) {
        unwatchEpisode(userId, p.tmdb_id, p.season_number!, p.episode_number!);
        return;
      }
    }

    const at = isoOrNull(p.watched_at);
    if (at && (p.media_type === "movie" || isEpisode)) {
      const key = isEpisode ? `${p.media_type}:${p.tmdb_id}:${p.season_number}:${p.episode_number}` : `${p.media_type}:${p.tmdb_id}`;
      const t: Target = {
        mediaType: p.media_type, tmdbId: p.tmdb_id, season: p.season_number, episode: p.episode_number,
        title: p.media_type === "tv" ? showTitle(userId, p.tmdb_id) : (lib.getLibraryItem(userId, "movie", p.tmdb_id)?.title ?? `Movie ${p.tmdb_id}`),
      };
      eachService(userId, () => {
        const pending = findBySubject(userId, `watch:${key}:${at}`);
        if (pending) deleteById(pending.id);
        else insert(userId, t, `unplay:${key}:${at}`, "unplay", { watched_at: at });
      });
    }
    syncWatchedDate(userId, f);
  });
}

/**
 * "Remove all plays": the movie / episode / whole show is no longer watched. A movie leaves the library. A show: every
 * episode's plays and ticks go (each sent to the services as un-watched) and the show leaves the library. Before,
 * this deleted the plays without telling Sync, and on a show page left every episode ticked.
 */
export function trackedRemoveAllPlays(userId: string, f: plays.PlayFilter): void {
  transaction(() => {
    if (f.mediaType === "movie") {
      unwatchMovie(userId, f.tmdbId);
      return;
    }
    if (f.seasonNumber != null && f.episodeNumber != null) {
      unwatchEpisode(userId, f.tmdbId, f.seasonNumber, f.episodeNumber);
      return;
    }
    const eps = new Map<string, [number, number]>();
    const add = (s: number | null, e: number | null) => {
      if (s == null || e == null || (f.seasonNumber != null && s !== f.seasonNumber)) return;
      eps.set(`${s}:${e}`, [s, e]);
    };
    for (const r of lib.listEpisodeProgress(userId, f.tmdbId)) add(r.season_number, r.episode_number);
    for (const r of plays.listPlays(userId, f)) add(r.season_number, r.episode_number);
    for (const [s, e] of eps.values()) unwatchEpisode(userId, f.tmdbId, s, e);
    plays.removeAllPlays(userId, f); // any play without an episode number
    if (f.seasonNumber == null) trackedRemoveLibraryItem(userId, "tv", f.tmdbId);
  });
}

// ---------- lists ----------

function listRow(userId: string, id: string): ListRow | undefined {
  return getDb().prepare(`SELECT * FROM lists WHERE id = ? AND user_id = ?`).get(id, userId) as ListRow | undefined;
}

const listTarget = (l: Pick<ListRow, "name">): Target => ({ mediaType: "movie", tmdbId: 0, title: l.name });

export function trackedCreateList(userId: string, name: string, description: string | null): ListRow {
  return transaction(() => {
    const l = lists.createList(userId, name, description);
    eachService(userId, () =>
      insert(userId, listTarget(l), `list:${l.id}`, "list", {
        value: 1, list_id: l.id, list_name: l.name, prev_name: null, list_description: l.description,
      }),
    );
    return l;
  });
}

export function trackedUpdateList(
  userId: string,
  id: string,
  patch: { name?: string; description?: string | null },
): ListRow {
  return transaction(() => {
    const before = listRow(userId, id);
    const after = lists.updateList(userId, id, patch);
    if (!before || (before.name === after.name && before.description === after.description)) return after;
    eachService(userId, () => {
      const pending = findBySubject(userId, `list:${id}`);
      if (pending) {
        getDb()
          .prepare(`UPDATE sync_changes SET list_name = ?, list_description = ?, title = ? WHERE id = ?`)
          .run(after.name, after.description, after.name, pending.id);
      } else {
        insert(userId, listTarget(after), `list:${id}`, "list", {
          value: 1, list_id: id, list_name: after.name, prev_name: before.name, list_description: after.description,
        });
      }
    });
    return after;
  });
}

export function trackedDeleteList(userId: string, id: string): void {
  transaction(() => {
    const before = listRow(userId, id);
    lists.deleteList(userId, id);
    if (!before) return;
    eachService(userId, () => {
      // Waiting changes to this list's items no longer matter.
      getDb()
        .prepare(`DELETE FROM sync_changes WHERE user_id = ? AND service = ? AND kind = 'list_item' AND list_id = ?`)
        .run(userId, current, id);
      const pending = findBySubject(userId, `list:${id}`);
      if (pending) {
        deleteById(pending.id);
        if (pending.prev_name === null) return; // created here and never sent: nothing to delete there
      }
      const remoteName = pending?.prev_name ?? before.name;
      insert(userId, listTarget({ name: remoteName }), `list:${id}`, "list", {
        value: 0, list_id: id, list_name: remoteName,
      });
    });
  });
}

export function trackedAddToList(userId: string, d: Parameters<typeof lists.addToList>[1]): void {
  transaction(() => {
    const already = lists.getListsContainingItem(userId, d.mediaType, d.tmdbId).includes(d.listId);
    lists.addToList(userId, d);
    const l = listRow(userId, d.listId);
    if (already || !l) return;
    const t: Target = { mediaType: d.mediaType, tmdbId: d.tmdbId, title: d.title };
    eachService(userId, () =>
      recordToggle(userId, t, "list_item", `list_item:${d.listId}:${d.mediaType}:${d.tmdbId}`, true, {
        list_id: d.listId, list_name: l.name,
      }),
    );
  });
}

export function trackedRemoveFromList(userId: string, listId: string, mediaType: MediaKind, tmdbId: number): void {
  transaction(() => {
    const item = getDb()
      .prepare(`SELECT title FROM list_items WHERE user_id = ? AND list_id = ? AND media_type = ? AND tmdb_id = ?`)
      .get(userId, listId, mediaType, tmdbId) as { title: string } | undefined;
    lists.removeFromList(userId, listId, mediaType, tmdbId);
    const l = listRow(userId, listId);
    if (!item || !l) return;
    const t: Target = { mediaType, tmdbId, title: item.title };
    eachService(userId, () =>
      recordToggle(userId, t, "list_item", `list_item:${listId}:${mediaType}:${tmdbId}`, false, {
        list_id: listId, list_name: l.name,
      }),
    );
  });
}

/** The list's name on the services and its name here now, for matching a waiting change to a service's list. */
export function listNamesFor(userId: string, service: SyncService, listId: string | null): { now: string | null; remote: string | null } {
  if (!listId) return { now: null, remote: null };
  const local = listRow(userId, listId);
  const meta = getDb()
    .prepare(`SELECT prev_name, list_name, value FROM sync_changes WHERE user_id = ? AND service = ? AND subject = ?`)
    .get(userId, service, `list:${listId}`) as { prev_name: string | null; list_name: string | null; value: number } | undefined;
  return { now: local?.name ?? meta?.list_name ?? null, remote: meta?.prev_name ?? local?.name ?? null };
}

export function listDescription(userId: string, listId: string | null): string | null {
  return listId ? (listRow(userId, listId)?.description ?? null) : null;
}

// ---------- reading and clearing the queue ----------

export function listSyncChanges(userId: string, service: SyncService): SyncChange[] {
  return getDb()
    .prepare(`SELECT * FROM sync_changes WHERE user_id = ? AND service = ? ORDER BY created_at, rowid`)
    .all(userId, service) as SyncChange[];
}

export function countSyncChanges(userId: string, service: SyncService): number {
  const r = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM sync_changes WHERE user_id = ? AND service = ?`)
    .get(userId, service) as { n: number };
  return r.n;
}

/** Forget what was waiting for a service that is no longer connected, so it is not sent if it is connected again later. */
export function dropChangesForDisconnected(userId: string): void {
  const connected = connectedServices(userId);
  for (const s of SYNC_SERVICES) {
    if (!connected.includes(s)) getDb().prepare(`DELETE FROM sync_changes WHERE user_id = ? AND service = ?`).run(userId, s);
  }
}

export function deleteSyncChanges(userId: string, ids: string[]): number {
  if (!ids.length) return 0;
  return transaction(() => {
    const stmt = getDb().prepare(`DELETE FROM sync_changes WHERE user_id = ? AND id = ?`);
    let n = 0;
    for (const id of ids) n += stmt.run(userId, id).changes;
    return n;
  });
}

export function clearSyncChanges(): void {
  getDb().prepare(`DELETE FROM sync_changes`).run();
}
