import { getDb, newId } from "./db.ts";
import type { MediaKind, PlayRow } from "./types.ts";

export interface PlayFilter {
  mediaType: MediaKind;
  tmdbId: number;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
}

function where(userId: string, f: PlayFilter) {
  const clauses = ["user_id = ?", "media_type = ?", "tmdb_id = ?"];
  const vals: (string | number)[] = [userId, f.mediaType, f.tmdbId];
  if (f.seasonNumber != null) {
    clauses.push("season_number = ?");
    vals.push(f.seasonNumber);
  }
  if (f.episodeNumber != null) {
    clauses.push("episode_number = ?");
    vals.push(f.episodeNumber);
  }
  return { sql: clauses.join(" AND "), vals };
}

export function listPlays(userId: string, f: PlayFilter) {
  const w = where(userId, f);
  return getDb()
    .prepare(
      `SELECT id, watched_at, rating, season_number, episode_number FROM plays
       WHERE ${w.sql} ORDER BY watched_at DESC`,
    )
    .all(...w.vals) as Pick<
    PlayRow,
    "id" | "watched_at" | "rating" | "season_number" | "episode_number"
  >[];
}

export function addPlay(
  userId: string,
  d: PlayFilter & { watchedAt: string; rating?: number | null },
): PlayRow {
  const db = getDb();
  const id = newId();
  db.prepare(
    `INSERT INTO plays (id, user_id, media_type, tmdb_id, season_number, episode_number, watched_at, rating)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    userId,
    d.mediaType,
    d.tmdbId,
    d.seasonNumber ?? null,
    d.episodeNumber ?? null,
    d.watchedAt,
    d.rating ?? null,
  );
  return db.prepare(`SELECT * FROM plays WHERE id = ?`).get(id) as PlayRow;
}

export function removePlay(userId: string, id: string): void {
  getDb().prepare(`DELETE FROM plays WHERE id = ? AND user_id = ?`).run(id, userId);
}

export function removeAllPlays(userId: string, f: PlayFilter): void {
  const w = where(userId, f);
  getDb().prepare(`DELETE FROM plays WHERE ${w.sql}`).run(...w.vals);
}
