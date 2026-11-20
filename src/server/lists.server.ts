import { getDb, newId, nowIso, upsertRow } from "./db.ts";
import type { ListItemRow, ListRow, MediaKind } from "./types.ts";

export function listListsWithPreview(userId: string) {
  const db = getDb();
  const lists = db
    .prepare(`SELECT * FROM lists WHERE user_id = ? ORDER BY updated_at DESC`)
    .all(userId) as ListRow[];
  if (!lists.length) return [];
  const items = db
    .prepare(
      `SELECT list_id, poster_path FROM list_items WHERE user_id = ? ORDER BY added_at DESC`,
    )
    .all(userId) as { list_id: string; poster_path: string | null }[];
  const counts: Record<string, number> = {};
  const previews: Record<string, { poster_path: string | null }[]> = {};
  for (const it of items) {
    counts[it.list_id] = (counts[it.list_id] ?? 0) + 1;
    (previews[it.list_id] ??= []);
    if (previews[it.list_id].length < 4) previews[it.list_id].push({ poster_path: it.poster_path });
  }
  return lists.map((l) => ({
    ...l,
    item_count: counts[l.id] ?? 0,
    preview_posters: previews[l.id] ?? [],
  }));
}

export function getListWithItems(userId: string, id: string) {
  const db = getDb();
  const list = db.prepare(`SELECT * FROM lists WHERE id = ? AND user_id = ?`).get(id, userId) as
    | ListRow
    | undefined;
  if (!list) return null;
  const items = db
    .prepare(`SELECT * FROM list_items WHERE list_id = ? ORDER BY added_at DESC`)
    .all(id) as ListItemRow[];
  return { ...list, items };
}

export function createList(userId: string, name: string, description: string | null): ListRow {
  const id = newId();
  const now = nowIso();
  getDb()
    .prepare(
      `INSERT INTO lists (id, user_id, name, description, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
    )
    .run(id, userId, name, description, now, now);
  return getDb().prepare(`SELECT * FROM lists WHERE id = ?`).get(id) as ListRow;
}

export function updateList(
  userId: string,
  id: string,
  patch: { name?: string; description?: string | null },
): ListRow {
  const sets: string[] = [];
  const vals: (string | null)[] = [];
  if (patch.name !== undefined) {
    sets.push("name = ?");
    vals.push(patch.name);
  }
  if (patch.description !== undefined) {
    sets.push("description = ?");
    vals.push(patch.description);
  }
  sets.push("updated_at = ?");
  vals.push(nowIso());
  const db = getDb();
  const res = db
    .prepare(`UPDATE lists SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`)
    .run(...vals, id, userId);
  if (res.changes === 0) throw new Error("List not found");
  return db.prepare(`SELECT * FROM lists WHERE id = ?`).get(id) as ListRow;
}

export function deleteList(userId: string, id: string): void {
  getDb().prepare(`DELETE FROM lists WHERE id = ? AND user_id = ?`).run(id, userId);
}

export function addToList(
  userId: string,
  d: {
    listId: string;
    mediaType: MediaKind;
    tmdbId: number;
    title: string;
    posterPath?: string | null;
    backdropPath?: string | null;
    releaseDate?: string | null;
  },
): void {
  const db = getDb();
  const owns = db.prepare(`SELECT 1 FROM lists WHERE id = ? AND user_id = ?`).get(d.listId, userId);
  if (!owns) throw new Error("List not found");
  db.transaction(() => {
    upsertRow(
      "list_items",
      {
        list_id: d.listId,
        user_id: userId,
        media_type: d.mediaType,
        tmdb_id: d.tmdbId,
        title: d.title,
        poster_path: d.posterPath ?? null,
        backdrop_path: d.backdropPath ?? null,
        release_date: d.releaseDate ?? null,
      },
      ["list_id", "media_type", "tmdb_id"],
    );
    db.prepare(`UPDATE lists SET updated_at = ? WHERE id = ?`).run(nowIso(), d.listId);
  })();
}

export function removeFromList(
  userId: string,
  listId: string,
  mediaType: MediaKind,
  tmdbId: number,
): void {
  const db = getDb();
  const res = db
    .prepare(
      `DELETE FROM list_items WHERE user_id = ? AND list_id = ? AND media_type = ? AND tmdb_id = ?`,
    )
    .run(userId, listId, mediaType, tmdbId);
  // Taking something out counts as an update too (My Lists' "Last updated" sort).
  if (res.changes > 0) {
    db.prepare(`UPDATE lists SET updated_at = ? WHERE id = ? AND user_id = ?`).run(nowIso(), listId, userId);
  }
}

export function getListsContainingItem(
  userId: string,
  mediaType: MediaKind,
  tmdbId: number,
): string[] {
  const rows = getDb()
    .prepare(`SELECT list_id FROM list_items WHERE user_id = ? AND media_type = ? AND tmdb_id = ?`)
    .all(userId, mediaType, tmdbId) as { list_id: string }[];
  return rows.map((r) => r.list_id);
}

// ---- Trakt import helpers

export function findListIdByName(userId: string, name: string): string | null {
  const r = getDb()
    .prepare(`SELECT id FROM lists WHERE user_id = ? AND name = ? LIMIT 1`)
    .get(userId, name) as { id: string } | undefined;
  return r?.id ?? null;
}

export function importListItems(
  userId: string,
  listId: string,
  items: { media_type: MediaKind; tmdb_id: number; title: string; release_date: string | null }[],
): { inserted: number; duplicates: number } {
  const counts = { inserted: 0, duplicates: 0 };
  getDb().transaction(() => {
    for (const it of items) {
      const row = upsertRow(
        "list_items",
        { list_id: listId, user_id: userId, ...it },
        ["list_id", "media_type", "tmdb_id"],
        { ignoreDuplicates: true },
      );
      // DO NOTHING + RETURNING yields no row when the item was already in the list.
      if (row) counts.inserted++;
      else counts.duplicates++;
    }
  })();
  return counts;
}

/** Every title that is in at least one of the user's lists, as "movie:123" / "tv:456". */
export function listedItemKeys(userId: string): string[] {
  const rows = getDb()
    .prepare(`SELECT DISTINCT media_type, tmdb_id FROM list_items WHERE user_id = ?`)
    .all(userId) as { media_type: MediaKind; tmdb_id: number }[];
  return rows.map((r) => `${r.media_type}:${r.tmdb_id}`);
}
