import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth-middleware";
import { getRedirectUri, traktGet, traktGetAll, traktPost, traktSend, withTraktToken } from "@/lib/trakt.server";
import { createBackup, readSetting, writeSetting } from "@/server/backup.server";
import { logError, redactText } from "@/server/redact.server";
import {
  connectedServices, countSyncChanges, deleteSyncChanges, dropChangesForDisconnected,
} from "@/server/sync-changes.server";
import {
  buildSyncPreview, MAX_PER_SYNC, runSyncPush, type PreviewItem, type Remote, type SyncService,
} from "@/server/sync-push.server";
import type { MirrorChoice, MirrorItem } from "@/server/mirror.server";
import {
  clearMirrorJob, getMirrorJob, startMirrorApply, startMirrorCompare, type MirrorJob,
} from "@/server/mirror-job.server";
import type { ProgressEvent } from "@/server/trakt-import.server";
import { getTraktConnectionRow } from "@/server/trakt-store.server";
import {
  getWetrakrConnectionRow, wetrakrConfigured, wetrakrGet, wetrakrGetAll, wetrakrPost, wetrakrSend, withWetrakrToken,
} from "@/server/wetrakr.server";

export type { MirrorItem, MirrorJob, PreviewItem, SyncService };

/** The chosen service while it is still connected; otherwise whichever one is. Import reads from it. */
function activeService(userId: string): SyncService | null {
  const connected = connectedServices(userId);
  const stored = readSetting("sync.active");
  if ((stored === "trakt" || stored === "wetrakr") && connected.includes(stored)) return stored;
  return connected[0] ?? null;
}

/** Removals wait for a tick in the Sync preview unless this is switched off. On by default. */
function confirmDeletions(): boolean {
  return readSetting("sync.confirmDeletions") !== "off";
}

/**
 * Settings -> Sync, "Where your library lives": which services are connected, which
 * one is active, and how many changes are waiting for each. Only safe public fields; tokens
 * never leave the server.
 */
export const getSyncState = createServerFn({ method: "GET" })
  .middleware([requireUser])
  .handler(async ({ context }) => {
    const trakt = getTraktConnectionRow(context.userId);
    const wetrakr = getWetrakrConnectionRow(context.userId);
    dropChangesForDisconnected(context.userId);
    return {
      active: activeService(context.userId),
      trakt: { connected: !!trakt, username: trakt?.trakt_username ?? null },
      wetrakr: { configured: wetrakrConfigured(), connected: !!wetrakr, username: wetrakr?.username ?? null },
      pending: {
        trakt: trakt ? countSyncChanges(context.userId, "trakt") : 0,
        wetrakr: wetrakr ? countSyncChanges(context.userId, "wetrakr") : 0,
      },
      confirmDeletions: confirmDeletions(),
      maxPerSync: MAX_PER_SYNC,
    };
  });

export const setActiveService = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .inputValidator((d: unknown) => z.object({ service: z.enum(["trakt", "wetrakr"]) }).parse(d))
  .handler(async ({ data }) => {
    writeSetting("sync.active", data.service);
    return { ok: true };
  });

export const setConfirmDeletions = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .inputValidator((d: unknown) => z.object({ on: z.boolean() }).parse(d))
  .handler(async ({ data }) => {
    writeSetting("sync.confirmDeletions", data.on ? "on" : "off");
    return { ok: true };
  });

/** One service, reachable with a valid sign-in. */
async function remoteFor(userId: string, service: SyncService): Promise<Remote> {
  if (service === "trakt") {
    const token = await withTraktToken(userId, getRedirectUri(getRequest().url));
    return {
      get: (path) => traktGet(path, token),
      getAll: async (path) => (await traktGetAll<never>(path, token)).items,
      post: (path, body) => traktPost(path, body, token),
      write: (method, path, body) => traktSend(method, path, body, token),
    };
  }
  const token = await withWetrakrToken(userId);
  return {
    get: (path) => wetrakrGet(path, token),
    getAll: async (path, onPage) => (await wetrakrGetAll<never>(path, token, onPage)).items,
    post: (path, body, key) => wetrakrPost(path, body, token, key),
    write: (method, path, body, key) => wetrakrSend(method, path, body, token, key),
  };
}

export type SyncPreviewGroup =
  | { service: SyncService; ok: true; items: PreviewItem[] }
  | { service: SyncService; ok: false; message: string };

/**
 * What a sync would send to each connected service, checked against that service. Only reads:
 * nothing is changed here or there.
 */
export const getSyncPreview = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .handler(async ({ context }) => {
    const groups: SyncPreviewGroup[] = [];
    for (const service of connectedServices(context.userId)) {
      try {
        const remote = await remoteFor(context.userId, service);
        groups.push({ service, ok: true, items: await buildSyncPreview(context.userId, service, remote) });
      } catch (e) {
        logError(`Sync preview failed for ${service}`, e);
        groups.push({ service, ok: false, message: redactText(e instanceof Error ? e.message : "Could not check") });
      }
    }
    return { groups, confirmDeletions: confirmDeletions(), maxPerSync: MAX_PER_SYNC };
  });

/**
 * Send the ticked changes, each to the service it is waiting for. A backup of the library is
 * saved first. One service failing does not stop the other: its changes simply keep waiting.
 * The final summary is keyed "service.count" (e.g. "trakt.sent").
 */
export const pushSync = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .inputValidator((d: unknown) => z.object({ ids: z.array(z.string().uuid()).max(MAX_PER_SYNC * 2) }).parse(d))
  .handler(async function* ({ data, context }): AsyncGenerator<ProgressEvent> {
    try {
      await createBackup("before-sync");
    } catch (e) {
      logError("Sync: backup before sync failed", e);
      yield { type: "error", message: "Could not save a backup first, so nothing was sent." };
      return;
    }
    const summary: Record<string, number> = {};
    for (const service of connectedServices(context.userId)) {
      const name = service === "trakt" ? "Trakt" : "WeTrakr";
      let remote: Remote;
      try {
        remote = await remoteFor(context.userId, service);
      } catch (e) {
        logError(`Sync: no usable sign-in for ${service}`, e);
        yield { type: "error", message: `${name}: ${redactText(e instanceof Error ? e.message : "Sync failed")}` };
        continue;
      }
      for await (const evt of runSyncPush(context.userId, service, remote, data.ids)) {
        if (evt.type === "done") {
          for (const [k, v] of Object.entries(evt.summary)) summary[`${service}.${k}`] = v;
        } else if (evt.type === "error") {
          yield { type: "error", message: `${name}: ${evt.message}` };
        } else {
          yield { ...evt, phase: name };
        }
      }
    }
    yield { type: "done", summary };
  });

/**
 * Compare with WeTrakr: the whole library here against the whole WeTrakr account, both ways
 * (see mirror.server.ts). It runs as a job on the server (mirror-job.server.ts), so a phone going to
 * sleep does not lose it: the page starts it, then asks how it is going.
 */
export const getWetrakrCompareJob = createServerFn({ method: "GET" })
  .middleware([requireUser])
  .handler(async ({ context }) => getMirrorJob(context.userId));

/** Start comparing (only reads). If a comparison or Apply is already running, that one is returned. */
export const startWetrakrCompare = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .handler(async ({ context }) => startMirrorCompare(context.userId, () => remoteFor(context.userId, "wetrakr")));

/** Apply the ticked lines of the comparison. A backup of the library is saved first. */
export const startWetrakrApply = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .inputValidator((d: unknown) =>
    z.object({
      choices: z.array(z.object({ id: z.string().min(1).max(300), side: z.enum(["send", "bring"]) })).max(20000),
    }).parse(d),
  )
  .handler(async ({ data, context }) =>
    startMirrorApply(context.userId, () => remoteFor(context.userId, "wetrakr"), data.choices as MirrorChoice[]),
  );

/** Forget a finished comparison or Apply, so the next visit starts fresh. */
export const clearWetrakrCompareJob = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .handler(async ({ context }) => {
    clearMirrorJob(context.userId);
    return { ok: true };
  });

/** Forget waiting changes without sending them. The library itself is not touched. */
export const discardSyncChanges = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .inputValidator((d: unknown) => z.object({ ids: z.array(z.string().uuid()).min(1).max(1000) }).parse(d))
  .handler(async ({ data, context }) => ({ removed: deleteSyncChanges(context.userId, data.ids) }));
