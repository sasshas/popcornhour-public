/**
 * Sync to Trakt (local library -> Trakt) is switched off. The implementation is kept in
 * src/server/trakt-import.server.ts (runSync) but is unreachable while this is false: the server
 * function refuses to run and the Settings button is disabled.
 *
 * Why: Trakt is the source of truth and the import is one-way. Re-enable only once things are
 * marked watched inside this app, and first fix pushing completed movies (no watched_at, so
 * Trakt would likely add a new play on every sync).
 *
 * Typed `boolean` (not the literal `false`) so TypeScript keeps checking the code behind the flag.
 */
export const TRAKT_SYNC_ENABLED: boolean = false as boolean;

export const TRAKT_SYNC_DISABLED_MESSAGE =
  "Sync to Trakt is disabled. Import from Trakt still works; nothing is pushed back to your Trakt account.";
