import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { USER_ID } from "@/server/db";
import { getLibraryItem } from "@/server/library.server";
import { listPlays } from "@/server/plays.server";
// The tracked versions also note the change so Sync can send it later (see sync-changes.server.ts).
import { trackedAddPlay, trackedUpsertLibraryItem } from "@/server/sync-changes.server";
import { logError } from "@/server/redact.server";
import { json, refuseUnlessToken, tmdbTitle } from "@/server/public-api.server";

/**
 * Lets Ultrahour (the disc tracker) mark a movie watched here when it is ticked Watched there:
 *
 *   POST /api/public/watched  { tmdbId, title?, watchedAt?, again? }
 *     -> { watched: true, already: false }                                 marked watched now
 *     -> { watched: true, already: true, lastWatched, canAddAgain }        it was already watched: nothing changed
 *     -> { watched: true, already: true, added: true }                     (again) a new play was logged
 *
 * Not watched here yet: it does what the movie page's Watched button does (Watched with that date, plus one play), so
 * Sync sends it on as usual. Already watched: nothing changes, and the reply says when it was last watched so
 * Ultrahour can offer to log this watch as a rewatch. Sending `again: true` then adds that play (as the Watched
 * dialog's rewatch does), unless the latest watch here is already on the same day (Canberra time, as Ultrahour shows
 * dates): that stops an untick and re-tick, or a double tap, from logging the same watch twice. Movies only.
 * Protected by `Authorization: Bearer <LIST_API_TOKEN>`; with no LIST_API_TOKEN set it is switched off (503).
 */

const Body = z.object({
  tmdbId: z.number().int().positive(),
  title: z.string().trim().min(1).max(500).optional(),
  watchedAt: z.string().datetime({ offset: true }).optional(),
  again: z.boolean().optional(),
});

const sydneyDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Australia/Sydney",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const sameDay = (a: string, b: string) =>
  sydneyDay.format(new Date(a)) === sydneyDay.format(new Date(b));

/** The movie's latest watch here: its newest play, else the date on its library row (a watch with no plays). */
function lastWatched(tmdbId: number, rowWatchedAt: string | null): string | null {
  let latest = rowWatchedAt;
  for (const p of listPlays(USER_ID, { mediaType: "movie", tmdbId })) {
    if (!latest || Date.parse(p.watched_at) > Date.parse(latest)) latest = p.watched_at;
  }
  return latest;
}

export const Route = createFileRoute("/api/public/watched")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const refused = refuseUnlessToken(request);
        if (refused) return refused;
        try {
          const body = Body.parse(await request.json().catch(() => ({})));
          // A watch in the future (a wrong clock) would sort oddly; it counts as now instead.
          const at = body.watchedAt ? new Date(body.watchedAt) : new Date();
          const watchedAt = (at.getTime() > Date.now() ? new Date() : at).toISOString();

          const before = getLibraryItem(USER_ID, "movie", body.tmdbId);
          if (before?.status === "completed") {
            const last = lastWatched(body.tmdbId, before.watched_at);
            const canAddAgain = !last || !sameDay(last, watchedAt);
            if (!body.again || !canAddAgain) {
              return json({ watched: true, already: true, lastWatched: last, canAddAgain });
            }
            // A rewatch, as the movie page's Watched dialog logs one: the row's date moves to this watch when it is
            // the latest, and a play is added (a watch that had only a date first gets a play of its own).
            const isLatest = !last || Date.parse(watchedAt) >= Date.parse(last);
            trackedUpsertLibraryItem(USER_ID, {
              mediaType: "movie",
              tmdbId: body.tmdbId,
              title: before.title,
              posterPath: before.poster_path,
              backdropPath: before.backdrop_path,
              releaseDate: before.release_date,
              status: "completed",
              ...(isLatest ? { watchedAt } : {}),
            });
            trackedAddPlay(USER_ID, { mediaType: "movie", tmdbId: body.tmdbId, watchedAt });
            return json({ watched: true, already: true, added: true });
          }

          const t = await tmdbTitle("movie", body.tmdbId);
          const title = t?.title ?? before?.title ?? body.title;
          if (!title) return json({ error: "Title not found on TMDB" }, 404);
          trackedUpsertLibraryItem(USER_ID, {
            mediaType: "movie",
            tmdbId: body.tmdbId,
            title,
            posterPath: t ? (t.poster_path ?? null) : (before?.poster_path ?? null),
            backdropPath: t ? (t.backdrop_path ?? null) : (before?.backdrop_path ?? null),
            releaseDate: t ? (t.release_date || null) : (before?.release_date ?? null),
            status: "completed",
            watchedAt,
          });
          trackedAddPlay(USER_ID, { mediaType: "movie", tmdbId: body.tmdbId, watchedAt });
          return json({ watched: true, already: false });
        } catch (e) {
          if (e instanceof z.ZodError) return json({ error: "Bad request" }, 400);
          logError("watched endpoint failed", e);
          return json({ error: "Something went wrong" }, 500);
        }
      },
    },
  },
});
