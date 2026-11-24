import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { USER_ID } from "@/server/db";
import * as lists from "@/server/lists.server";
// The tracked versions also note the change so Sync can send it later (see sync-changes.server.ts).
import * as tracked from "@/server/sync-changes.server";
import { logError } from "@/server/redact.server";
import { json, refuseUnlessToken, tmdbTitle } from "@/server/public-api.server";

/**
 * Lets another app on the LAN (Ultrahour, the disc tracker) put a title on one of these lists, take it off, or ask
 * whether it is on it, without a sign-in cookie:
 *
 *   GET    /api/public/lists/<listId>/items?mediaType=movie&tmdbId=<id>  -> { list: { id, name }, onList }
 *   GET    /api/public/lists/<listId>/items                              -> { list, items: [{ mediaType, tmdbId }] }
 *   POST   /api/public/lists/<listId>/items  { mediaType, tmdbId, title? } -> adds it (TMDB fills in the rest)
 *   DELETE /api/public/lists/<listId>/items?mediaType=movie&tmdbId=<id>  -> takes it off
 *
 * Protected by `Authorization: Bearer <LIST_API_TOKEN>`; with no LIST_API_TOKEN set it is switched off (503).
 */

const MediaKind = z.enum(["movie", "tv"]);
const Item = z.object({ mediaType: MediaKind, tmdbId: z.coerce.number().int().positive() });
const AddBody = Item.extend({ title: z.string().trim().min(1).max(500).optional() });

/** Runs the handler only for a signed request to a list that exists. */
async function guarded(
  request: Request,
  listId: string,
  run: (list: { id: string; name: string }) => Promise<Response> | Response,
): Promise<Response> {
  const refused = refuseUnlessToken(request);
  if (refused) return refused;
  const list = lists.getListWithItems(USER_ID, listId);
  if (!list) return json({ error: "List not found" }, 404);
  try {
    return await run({ id: list.id, name: list.name });
  } catch (e) {
    if (e instanceof z.ZodError) return json({ error: "Bad request" }, 400);
    logError("list items endpoint failed", e, listId);
    return json({ error: "Something went wrong" }, 500);
  }
}

function itemFromQuery(request: Request) {
  const q = new URL(request.url).searchParams;
  return Item.parse({ mediaType: q.get("mediaType") ?? "movie", tmdbId: q.get("tmdbId") });
}

export const Route = createFileRoute("/api/public/lists/$listId/items")({
  server: {
    handlers: {
      GET: ({ request, params }) =>
        guarded(request, params.listId, (list) => {
          // No tmdbId: everything on the list (Ultrahour badges its whole vault grid from one call).
          if (!new URL(request.url).searchParams.has("tmdbId")) {
            const items = lists.listItemKeys(USER_ID, list.id).map((key) => {
              const [mediaType, id] = key.split(":");
              return { mediaType, tmdbId: Number(id) };
            });
            return json({ list, items });
          }
          const { mediaType, tmdbId } = itemFromQuery(request);
          const onList = lists.getListsContainingItem(USER_ID, mediaType, tmdbId).includes(list.id);
          return json({ list, onList });
        }),

      POST: ({ request, params }) =>
        guarded(request, params.listId, async (list) => {
          const body = AddBody.parse(await request.json().catch(() => ({})));
          const t = await tmdbTitle(body.mediaType, body.tmdbId);
          const title = t?.title ?? t?.name ?? body.title;
          if (!title) return json({ error: "Title not found on TMDB" }, 404);
          tracked.trackedAddToList(USER_ID, {
            listId: list.id,
            mediaType: body.mediaType,
            tmdbId: body.tmdbId,
            title,
            posterPath: t?.poster_path ?? null,
            backdropPath: t?.backdrop_path ?? null,
            releaseDate: (t?.release_date || t?.first_air_date) ?? null,
          });
          return json({ list, onList: true });
        }),

      DELETE: ({ request, params }) =>
        guarded(request, params.listId, (list) => {
          const { mediaType, tmdbId } = itemFromQuery(request);
          tracked.trackedRemoveFromList(USER_ID, list.id, mediaType, tmdbId);
          return json({ list, onList: false });
        }),
    },
  },
});
