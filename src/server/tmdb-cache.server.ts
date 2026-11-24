import { getDb, nowIso, transaction } from "./db.ts";

// A tiny read-through cache for small TMDB answers, stored in SQLite (table tmdb_cache).
// Keys are "<kind>:<media>:<id>", e.g. "score:movie:603". Values are JSON.

const CHUNK = 500; // keeps each IN (...) well under SQLite's variable limit

/**
 * Cached values younger than `ttlMs`, by key. Keys that are missing, expired or unreadable are left out. `ttlMs` can
 * be a function of the value, for answers that should be checked again sooner (see getMoviesAvailability).
 */
export function getCachedMany<T>(
  keys: string[],
  ttlMs: number | ((value: T) => number),
  now = Date.now(),
): Map<string, T> {
  const out = new Map<string, T>();
  const db = getDb();
  for (let i = 0; i < keys.length; i += CHUNK) {
    const part = keys.slice(i, i + CHUNK);
    const rows = db
      .prepare(`SELECT key, data, fetched_at FROM tmdb_cache WHERE key IN (${part.map(() => "?").join(",")})`)
      .all(...part) as { key: string; data: string; fetched_at: string }[];
    for (const r of rows) {
      try {
        const value = JSON.parse(r.data) as T;
        const ttl = typeof ttlMs === "function" ? ttlMs(value) : ttlMs;
        if (now - Date.parse(r.fetched_at) > ttl) continue;
        out.set(r.key, value);
      } catch {
        // unreadable: treated as a miss and overwritten on the next save
      }
    }
  }
  return out;
}

/** Store (or replace) several values at once, all stamped with the same fetch time. */
export function setCachedMany(entries: [key: string, value: unknown][]): void {
  if (!entries.length) return;
  const stmt = getDb().prepare(
    `INSERT INTO tmdb_cache (key, data, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`,
  );
  const at = nowIso();
  transaction(() => {
    for (const [key, value] of entries) stmt.run(key, JSON.stringify(value), at);
  });
}

/** One cached value with the time it was stored, for callers that decide freshness themselves. */
export function getCachedEntry<T>(key: string): { value: T; fetchedAt: number } | null {
  const row = getDb().prepare(`SELECT data, fetched_at FROM tmdb_cache WHERE key = ?`).get(key) as
    | { data: string; fetched_at: string }
    | undefined;
  if (!row) return null;
  try {
    return { value: JSON.parse(row.data) as T, fetchedAt: Date.parse(row.fetched_at) };
  } catch {
    return null; // unreadable: treated as a miss and overwritten on the next save
  }
}
