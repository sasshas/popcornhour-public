/**
 * A watch with no date ("Unknown date") is kept as the very start of 1970 (UTC). The watched_at columns need a
 * date, and this one sorts below every real watch, so an unknown-date play never counts as the latest watch.
 * Trakt is sent its own "unknown" keyword for it (POST /sync/history: "Set to `unknown` to mark the item as watched
 * without a specific date"); the rest of the app shows it as "Unknown date".
 */
export const UNKNOWN_WATCHED_AT = "1970-01-01T00:00:00.000Z";

/** True for the unknown-date marker. Anything within two days of it counts, so a time-zone shift still matches. */
export function isUnknownWatchedAt(input?: string | Date | null): boolean {
  if (!input) return false;
  const t = typeof input === "string" ? Date.parse(input) : input.getTime();
  return !Number.isNaN(t) && Math.abs(t) < 2 * 24 * 3600 * 1000;
}
