import { getDb, upsertRow } from "./db.ts";
import type { TraktConnectionRow } from "./types.ts";

export function getTraktConnectionRow(userId: string): TraktConnectionRow | null {
  return (
    (getDb().prepare(`SELECT * FROM trakt_connections WHERE user_id = ?`).get(userId) as
      | TraktConnectionRow
      | undefined) ?? null
  );
}

export function saveTraktConnection(
  userId: string,
  row: {
    access_token: string;
    refresh_token: string;
    expires_at: string;
    scope: string | null;
    trakt_user_id?: string;
    trakt_username?: string;
    trakt_slug?: string;
  },
): void {
  upsertRow("trakt_connections", { user_id: userId, ...row }, ["user_id"]);
}

export function deleteTraktConnection(userId: string): void {
  getDb().prepare(`DELETE FROM trakt_connections WHERE user_id = ?`).run(userId);
}
