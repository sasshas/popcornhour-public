import { getDb, newId, nowIso, transaction, upsertRow } from "./db.ts";
import type {
  EpisodeProgressRow,
  LibraryItem,
  LibraryStatus,
  MediaKind,
  Profile,
} from "./types.ts";

type RawLibrary = Omit<LibraryItem, "watchlist" | "favorite"> & {
  watchlist: number;
  favorite: number;
};

function toItem(r: RawLibrary): LibraryItem {
  return { ...r, watchlist: !!r.watchlist, favorite: !!r.favorite };
}

export function listLibraryItems(userId: string): LibraryItem[] {
  const rows = getDb()
    .prepare(
      `SELECT l.*,
              CASE WHEN l.media_type = 'tv'
                   THEN (SELECT MAX(e.watched_at) FROM episode_progress e
                          WHERE e.user_id = l.user_id AND e.tv_tmdb_id = l.tmdb_id)
                   ELSE l.watched_at END AS last_watched_at
         FROM library_items l WHERE l.user_id = ? ORDER BY l.updated_at DESC`,
    )
    .all(userId) as RawLibrary[];
  return rows.map(toItem);
}

export function getLibraryItem(
  userId: string,
  mediaType: MediaKind,
  tmdbId: number,
): LibraryItem | null {
  const r = getDb()
    .prepare(`SELECT * FROM library_items WHERE user_id = ? AND media_type = ? AND tmdb_id = ?`)
    .get(userId, mediaType, tmdbId) as RawLibrary | undefined;
  return r ? toItem(r) : null;
}

export interface UpsertLibraryInput {
  mediaType: MediaKind;
  tmdbId: number;
  title: string;
  posterPath?: string | null;
  backdropPath?: string | null;
  releaseDate?: string | null;
  status?: LibraryStatus;
  watchlist?: boolean;
  favorite?: boolean;
  rating?: number | null;
  notes?: string | null;
  watchedAt?: string | null;
}

/** Mirrors the old behaviour: poster/backdrop/release_date are always written; the rest only if provided. */
export function upsertLibraryItem(userId: string, d: UpsertLibraryInput): LibraryItem {
  const r = upsertRow<RawLibrary>(
    "library_items",
    {
      user_id: userId,
      media_type: d.mediaType,
      tmdb_id: d.tmdbId,
      title: d.title,
      poster_path: d.posterPath ?? null,
      backdrop_path: d.backdropPath ?? null,
      release_date: d.releaseDate ?? null,
      status: d.status,
      watchlist: d.watchlist,
      favorite: d.favorite,
      rating: d.rating,
      notes: d.notes,
      watched_at: d.watchedAt,
    },
    ["user_id", "media_type", "tmdb_id"],
  );
  return toItem(r!);
}

export function removeLibraryItem(userId: string, mediaType: MediaKind, tmdbId: number): void {
  getDb()
    .prepare(`DELETE FROM library_items WHERE user_id = ? AND media_type = ? AND tmdb_id = ?`)
    .run(userId, mediaType, tmdbId);
}

// ---- Trakt import / sync / cron helpers

export interface ImportLibraryRow {
  media_type: MediaKind;
  tmdb_id: number;
  title: string;
  release_date: string | null;
  status: LibraryStatus;
  /** Movies: Trakt's last_watched_at. Stored in library_items.watched_at. */
  watched_at?: string | null;
  /**
   * Set the status exactly, even if that moves an existing title backward. Only the WeTrakr import
   * uses it, for shows the user marked Dropped or Paused there (the user chose WeTrakr to win).
   */
  exact_status?: boolean;
}

/**
 * Import status policy. A status only ever moves FORWARD (plan_to_watch -> watching -> completed),
 * and a status the user set to 'dropped' or 'on_hold' is never touched. New-season reactivation
 * ('completed' -> 'watching') is the job of check-new-seasons, not of the import.
 */
const STATUS_RANK: Partial<Record<LibraryStatus, number>> = {
  plan_to_watch: 0,
  watching: 1,
  completed: 2,
};

export function shouldAdvanceStatus(current: LibraryStatus, target: LibraryStatus): boolean {
  const c = STATUS_RANK[current];
  const t = STATUS_RANK[target];
  return c !== undefined && t !== undefined && t > c;
}

export type ImportCounts = {
  inserted: number;
  /** Existing rows whose status moved forward (or was set exactly, see exact_status). */
  advanced: number;
  /** Existing rows left as they were (same/higher status, or dropped/on_hold). */
  unchanged: number;
  /** Existing rows that got a watched_at (it was empty, or Trakt's is later). Independent of the status counts. */
  watchedAtSet: number;
};

/** True when `incoming` is a valid date and the stored one is empty or earlier. */
export function isNewerWatchedAt(stored: string | null, incoming: string | null | undefined): boolean {
  const inc = incoming ? Date.parse(incoming) : NaN;
  if (Number.isNaN(inc)) return false;
  const cur = stored ? Date.parse(stored) : NaN;
  return Number.isNaN(cur) || inc > cur;
}

/**
 * Insert new titles with the status Trakt implies; move existing ones forward only. A watched_at
 * from Trakt is filled in on existing rows when empty or earlier (never moved back, so a date
 * logged inside the app is kept); updated_at is not touched for that.
 */
export function importLibraryRows(userId: string, rows: ImportLibraryRow[]): ImportCounts {
  const counts: ImportCounts = { inserted: 0, advanced: 0, unchanged: 0, watchedAtSet: 0 };
  transaction(() => {
    const db = getDb();
    const find = db.prepare(
      `SELECT id, status, watched_at FROM library_items WHERE user_id = ? AND media_type = ? AND tmdb_id = ?`,
    );
    const advance = db.prepare(`UPDATE library_items SET status = ?, updated_at = ? WHERE id = ?`);
    const setWatchedAt = db.prepare(`UPDATE library_items SET watched_at = ? WHERE id = ?`);
    for (const { exact_status: exact, ...r } of rows) {
      const cur = find.get(userId, r.media_type, r.tmdb_id) as
        | { id: string; status: LibraryStatus; watched_at: string | null }
        | undefined;
      if (cur && isNewerWatchedAt(cur.watched_at, r.watched_at)) {
        setWatchedAt.run(r.watched_at, cur.id);
        counts.watchedAtSet++;
      }
      if (!cur) {
        upsertRow(
          "library_items",
          { user_id: userId, ...r },
          ["user_id", "media_type", "tmdb_id"],
          { ignoreDuplicates: true },
        );
        counts.inserted++;
      } else if (exact ? cur.status !== r.status : shouldAdvanceStatus(cur.status, r.status)) {
        advance.run(r.status, nowIso(), cur.id);
        counts.advanced++;
      } else {
        counts.unchanged++;
      }
    }
  });
  return counts;
}

export interface ImportEpisodeRow {
  tv_tmdb_id: number;
  season_number: number;
  episode_number: number;
  watched_at: string;
}

/** Insert watched episodes; rows already present (possibly edited by hand) are left alone. */
export function importEpisodeProgress(
  userId: string,
  rows: ImportEpisodeRow[],
): { inserted: number; existing: number } {
  const out = { inserted: 0, existing: 0 };
  transaction(() => {
    const stmt = getDb().prepare(
      `INSERT INTO episode_progress (id, user_id, tv_tmdb_id, season_number, episode_number, watched_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, tv_tmdb_id, season_number, episode_number) DO NOTHING`,
    );
    for (const r of rows) {
      const res = stmt.run(newId(), userId, r.tv_tmdb_id, r.season_number, r.episode_number, r.watched_at);
      if (res.changes > 0) out.inserted++;
      else out.existing++;
    }
  });
  return out;
}

/** Everything in episode_progress, for pushing to Trakt. */
export function listEpisodesForSync(userId: string): ImportEpisodeRow[] {
  return getDb()
    .prepare(
      `SELECT tv_tmdb_id, season_number, episode_number, watched_at FROM episode_progress
       WHERE user_id = ? ORDER BY tv_tmdb_id, season_number, episode_number`,
    )
    .all(userId) as ImportEpisodeRow[];
}

/** Returns false when the title is not in the library (nothing is created or changed). */
export function setLibraryRating(
  userId: string,
  mediaType: MediaKind,
  tmdbId: number,
  rating: number,
): boolean {
  const r = getDb()
    .prepare(
      `UPDATE library_items SET rating = ?, updated_at = ?
       WHERE user_id = ? AND media_type = ? AND tmdb_id = ?`,
    )
    .run(rating, nowIso(), userId, mediaType, tmdbId);
  return r.changes > 0;
}

export function listLibraryForSync(userId: string) {
  return getDb()
    .prepare(`SELECT media_type, tmdb_id, status, rating FROM library_items WHERE user_id = ?`)
    .all(userId) as {
    media_type: MediaKind;
    tmdb_id: number;
    status: LibraryStatus;
    rating: number | null;
  }[];
}

/** All TV items across users (the cron job has no user context). */
export function listAllTvItems() {
  return getDb()
    .prepare(`SELECT id, user_id, tmdb_id, status, last_known_seasons FROM library_items WHERE media_type = 'tv'`)
    .all() as {
    id: string;
    user_id: string;
    tmdb_id: number;
    status: LibraryStatus;
    last_known_seasons: number;
  }[];
}

export function patchTvSeasonState(
  id: string,
  patch: { last_known_seasons: number; status?: LibraryStatus },
): void {
  getDb()
    .prepare(
      `UPDATE library_items SET last_known_seasons = ?, status = COALESCE(?, status), updated_at = ?
       WHERE id = ?`,
    )
    .run(patch.last_known_seasons, patch.status ?? null, nowIso(), id);
}

// ---- Poster backfill (library_items + list_items)

export function listItemsMissingPoster(userId: string) {
  return getDb()
    .prepare(
      `SELECT media_type, tmdb_id FROM library_items WHERE user_id = ? AND poster_path IS NULL
       UNION
       SELECT media_type, tmdb_id FROM list_items WHERE user_id = ? AND poster_path IS NULL`,
    )
    .all(userId, userId) as { media_type: MediaKind; tmdb_id: number }[];
}

export function updatePosters(
  userId: string,
  mediaType: MediaKind,
  tmdbId: number,
  poster: string,
  backdrop: string | null,
): void {
  const db = getDb();
  transaction(() => {
    db.prepare(
      `UPDATE library_items SET poster_path = ?, backdrop_path = ?, updated_at = ?
       WHERE user_id = ? AND media_type = ? AND tmdb_id = ?`,
    ).run(poster, backdrop, nowIso(), userId, mediaType, tmdbId);
    db.prepare(
      `UPDATE list_items SET poster_path = ?, backdrop_path = ?
       WHERE user_id = ? AND media_type = ? AND tmdb_id = ?`,
    ).run(poster, backdrop, userId, mediaType, tmdbId);
  });
}

// ---- Episode progress

export function listEpisodeProgress(userId: string, tvTmdbId: number): EpisodeProgressRow[] {
  return getDb()
    .prepare(
      `SELECT season_number, episode_number, watched_at, rating
       FROM episode_progress WHERE user_id = ? AND tv_tmdb_id = ?`,
    )
    .all(userId, tvTmdbId) as EpisodeProgressRow[];
}

export function markEpisodeWatched(
  userId: string,
  d: {
    tvTmdbId: number;
    seasonNumber: number;
    episodeNumber: number;
    watchedAt?: string;
    rating?: number | null;
  },
): void {
  upsertRow(
    "episode_progress",
    {
      user_id: userId,
      tv_tmdb_id: d.tvTmdbId,
      season_number: d.seasonNumber,
      episode_number: d.episodeNumber,
      watched_at: d.watchedAt || undefined,
      rating: d.rating,
    },
    ["user_id", "tv_tmdb_id", "season_number", "episode_number"],
  );
}

export function unmarkEpisode(
  userId: string,
  tvTmdbId: number,
  seasonNumber: number,
  episodeNumber: number,
): void {
  getDb()
    .prepare(
      `DELETE FROM episode_progress
       WHERE user_id = ? AND tv_tmdb_id = ? AND season_number = ? AND episode_number = ?`,
    )
    .run(userId, tvTmdbId, seasonNumber, episodeNumber);
}

export function markEpisodes(
  userId: string,
  d: { tvTmdbId: number; seasonNumber: number; episodeNumbers: number[]; watchedAt?: string },
): number {
  transaction(() => {
    for (const n of d.episodeNumbers) {
      markEpisodeWatched(userId, {
        tvTmdbId: d.tvTmdbId,
        seasonNumber: d.seasonNumber,
        episodeNumber: n,
        watchedAt: d.watchedAt,
      });
    }
  });
  return d.episodeNumbers.length;
}

// ---- Profile

export function getProfile(userId: string): Profile | null {
  return (
    (getDb().prepare(`SELECT * FROM profiles WHERE user_id = ?`).get(userId) as Profile | undefined) ??
    null
  );
}

export function updateProfile(
  userId: string,
  patch: { displayName?: string | null; avatarUrl?: string | null },
): Profile {
  const sets: string[] = [];
  const vals: (string | null)[] = [];
  if (patch.displayName !== undefined) {
    sets.push("display_name = ?");
    vals.push(patch.displayName);
  }
  if (patch.avatarUrl !== undefined) {
    sets.push("avatar_url = ?");
    vals.push(patch.avatarUrl);
  }
  sets.push("updated_at = ?");
  vals.push(nowIso());
  const db = getDb();
  // Ensure the row exists (it's seeded at startup, but be safe).
  db.prepare(
    `INSERT OR IGNORE INTO profiles (id, user_id, display_name) VALUES (?, ?, 'Me')`,
  ).run(newId(), userId);
  db.prepare(`UPDATE profiles SET ${sets.join(", ")} WHERE user_id = ?`).run(...vals, userId);
  return getProfile(userId)!;
}
