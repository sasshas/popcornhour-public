import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireUser } from "@/lib/auth-middleware";
import * as lib from "@/server/library.server";
// The tracked versions also note the change so Sync can send it later (see sync-changes.server.ts).
import * as tracked from "@/server/sync-changes.server";
// After a tick the show may move between Watchlist, Watching and Watched (see tv-status.server.ts).
import { refreshShowStatus } from "@/server/tv-status.server";

const MediaKind = z.enum(["movie", "tv"]);
const Status = z.enum(["watching", "completed", "plan_to_watch", "dropped", "on_hold"]);

export const listLibrary = createServerFn({ method: "GET" })
  .middleware([requireUser])
  .handler(async ({ context }) => lib.listLibraryItems(context.userId));

export const getLibraryItem = createServerFn({ method: "GET" })
  .middleware([requireUser])
  .inputValidator((d: unknown) =>
    z.object({ mediaType: MediaKind, tmdbId: z.number().int().positive() }).parse(d),
  )
  .handler(async ({ data, context }) =>
    lib.getLibraryItem(context.userId, data.mediaType, data.tmdbId),
  );

export const upsertLibraryItem = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .inputValidator((d: unknown) =>
    z.object({
      mediaType: MediaKind,
      tmdbId: z.number().int().positive(),
      title: z.string().min(1).max(500),
      posterPath: z.string().nullable().optional(),
      backdropPath: z.string().nullable().optional(),
      releaseDate: z.string().nullable().optional(),
      status: Status.optional(),
      watchlist: z.boolean().optional(),
      favorite: z.boolean().optional(),
      rating: z.number().int().min(1).max(10).nullable().optional(),
      notes: z.string().max(2000).nullable().optional(),
      watchedAt: z.string().datetime().nullable().optional(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => tracked.trackedUpsertLibraryItem(context.userId, data));

export const removeLibraryItem = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .inputValidator((d: unknown) =>
    z.object({ mediaType: MediaKind, tmdbId: z.number().int().positive() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    tracked.trackedRemoveLibraryItem(context.userId, data.mediaType, data.tmdbId);
    return { ok: true };
  });

export const listEpisodeProgress = createServerFn({ method: "GET" })
  .middleware([requireUser])
  .inputValidator((d: unknown) => z.object({ tvTmdbId: z.number().int().positive() }).parse(d))
  .handler(async ({ data, context }) => lib.listEpisodeProgress(context.userId, data.tvTmdbId));

export const toggleEpisode = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .inputValidator((d: unknown) =>
    z.object({
      tvTmdbId: z.number().int().positive(),
      seasonNumber: z.number().int().min(0),
      episodeNumber: z.number().int().min(0),
      watched: z.boolean(),
      watchedAt: z.string().datetime().optional(),
      rating: z.number().int().min(1).max(10).nullable().optional(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    if (data.watched) {
      tracked.trackedMarkEpisodeWatched(context.userId, data);
    } else {
      tracked.trackedUnmarkEpisode(context.userId, data.tvTmdbId, data.seasonNumber, data.episodeNumber);
    }
    await refreshShowStatus(context.userId, data.tvTmdbId);
    return { ok: true };
  });

export const markEpisodesUpTo = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .inputValidator((d: unknown) =>
    z.object({
      tvTmdbId: z.number().int().positive(),
      seasonNumber: z.number().int().min(0),
      throughEpisode: z.number().int().min(0),
      episodeNumbers: z.array(z.number().int().min(0)).min(1).max(500),
      watchedAt: z.string().datetime().optional(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const episodeNumbers = data.episodeNumbers.filter((n) => n <= data.throughEpisode);
    if (!episodeNumbers.length) return { ok: true, count: 0 };
    const count = tracked.trackedMarkEpisodes(context.userId, {
      tvTmdbId: data.tvTmdbId,
      seasonNumber: data.seasonNumber,
      episodeNumbers,
      watchedAt: data.watchedAt,
    });
    await refreshShowStatus(context.userId, data.tvTmdbId);
    return { ok: true, count };
  });

export const getMyProfile = createServerFn({ method: "GET" })
  .middleware([requireUser])
  .handler(async ({ context }) => lib.getProfile(context.userId));

export const updateMyProfile = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .inputValidator((d: unknown) =>
    z.object({
      displayName: z.string().trim().min(1).max(80).nullable().optional(),
      avatarUrl: z.string().url().max(500).nullable().optional(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => lib.updateProfile(context.userId, data));
