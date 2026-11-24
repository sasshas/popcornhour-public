import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireUser } from "@/lib/auth-middleware";
import * as plays from "@/server/plays.server";
import { trackedAddPlay, trackedRemoveAllPlays, trackedRemovePlay } from "@/server/sync-changes.server";
import { refreshShowStatus, showOfPlay } from "@/server/tv-status.server";

const MediaKind = z.enum(["movie", "tv"]);

const filterSchema = z.object({
  mediaType: MediaKind,
  tmdbId: z.number().int().positive(),
  seasonNumber: z.number().int().min(0).nullable().optional(),
  episodeNumber: z.number().int().min(0).nullable().optional(),
});

export const listPlays = createServerFn({ method: "GET" })
  .middleware([requireUser])
  .inputValidator((d: unknown) => filterSchema.parse(d))
  .handler(async ({ data, context }) => plays.listPlays(context.userId, data));

export const addPlay = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .inputValidator((d: unknown) =>
    filterSchema
      .extend({
        watchedAt: z.string().datetime(),
        rating: z.number().int().min(1).max(10).nullable().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => trackedAddPlay(context.userId, data));

export const removePlay = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const show = showOfPlay(context.userId, data.id);
    trackedRemovePlay(context.userId, data.id); // the last play of an episode unticks it
    if (show) await refreshShowStatus(context.userId, show);
    return { ok: true };
  });

export const removeAllPlays = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .inputValidator((d: unknown) => filterSchema.parse(d))
  .handler(async ({ data, context }) => {
    trackedRemoveAllPlays(context.userId, data);
    // An episode's or a season's plays: ticks went. (A whole show's leaves the library, so there is nothing to move.)
    if (data.mediaType === "tv" && data.seasonNumber != null) await refreshShowStatus(context.userId, data.tmdbId);
    return { ok: true };
  });
