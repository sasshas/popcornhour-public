import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { requireUser } from "@/lib/auth-middleware";
import { getRedirectUri, revokeToken, withTraktToken } from "@/lib/trakt.server";
import { deleteTraktConnection, getTraktConnectionRow } from "@/server/trakt-store.server";
import { runImport, runSync, type ProgressEvent } from "@/server/trakt-import.server";
import { logError, redactText } from "@/server/redact.server";
import { createBackup } from "@/server/backup.server";
import { TRAKT_SYNC_DISABLED_MESSAGE, TRAKT_SYNC_ENABLED } from "@/lib/features";

function redirectUri() {
  return getRedirectUri(getRequest().url);
}

/** Returns ONLY safe public fields. Tokens never leave the server. */
export const getTraktConnection = createServerFn({ method: "GET" })
  .middleware([requireUser])
  .handler(async ({ context }) => {
    const data = getTraktConnectionRow(context.userId);
    if (!data) return { connected: false as const, username: null, connectedAt: null };
    return {
      connected: true as const,
      username: data.trakt_username,
      slug: data.trakt_slug,
      connectedAt: data.connected_at,
    };
  });

export const disconnectTrakt = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .handler(async ({ context }) => {
    const data = getTraktConnectionRow(context.userId);
    if (data?.access_token) await revokeToken(data.access_token);
    deleteTraktConnection(context.userId);
    return { ok: true };
  });

/** Valid access token (refreshing if needed), or null after yielding why not. */
async function tokenOrError(
  userId: string,
  label: string,
): Promise<{ token: string } | { error: ProgressEvent }> {
  try {
    return { token: await withTraktToken(userId, redirectUri()) };
  } catch (e) {
    logError(`${label}: no usable Trakt token`, e);
    return { error: { type: "error", message: redactText(e instanceof Error ? e.message : `${label} failed`) } };
  }
}

// Import: Trakt -> local library, episodes and lists. See src/server/trakt-import.server.ts.
export const importFromTrakt = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .handler(async function* ({ context }): AsyncGenerator<ProgressEvent> {
    const t = await tokenOrError(context.userId, "Trakt import");
    if ("error" in t) {
      yield t.error;
      return;
    }
    // Safety net: the library as it was before this import can be restored from Settings -> Backup.
    try {
      await createBackup("before-import");
    } catch (e) {
      logError("Trakt import: backup before import failed", e);
      yield { type: "error", message: "Could not save a backup first, so the import was not started." };
      return;
    }
    yield* runImport(context.userId, t.token);
  });

// Sync: local library -> Trakt. Shows go out as individual episodes only.
// DISABLED via TRAKT_SYNC_ENABLED (src/lib/features.ts): returns an error event and does nothing.
export const syncToTrakt = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .handler(async function* ({ context }): AsyncGenerator<ProgressEvent> {
    if (!TRAKT_SYNC_ENABLED) {
      yield { type: "error", message: TRAKT_SYNC_DISABLED_MESSAGE };
      return;
    }
    const t = await tokenOrError(context.userId, "Trakt sync");
    if ("error" in t) {
      yield t.error;
      return;
    }
    yield* runSync(context.userId, t.token);
  });
