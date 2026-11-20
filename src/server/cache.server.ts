import { getDb, upsertRow } from "./db.ts";

/** Parents-guide cache: arbitrary JSON keyed by IMDb id. */
export function getParentsGuideCache<T>(imdbId: string): T | null {
  const r = getDb()
    .prepare(`SELECT data FROM parents_guide_cache WHERE imdb_id = ?`)
    .get(imdbId) as { data: string } | undefined;
  if (!r) return null;
  try {
    return JSON.parse(r.data) as T;
  } catch {
    return null;
  }
}

export function setParentsGuideCache(imdbId: string, data: unknown): void {
  upsertRow("parents_guide_cache", { imdb_id: imdbId, data: JSON.stringify(data) }, ["imdb_id"]);
}
