import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireUser } from "@/lib/auth-middleware";
import * as lists from "@/server/lists.server";
import { transaction } from "@/server/db";
// The tracked versions also note the change so Sync can send it later (see sync-changes.server.ts).
import * as tracked from "@/server/sync-changes.server";
import { importMdblistList, ImportProblem } from "@/server/mdblist-import.server";
import { matchTitles, TITLE_IMPORT_MAX_LINES } from "@/server/title-match.server";

const MediaKind = z.enum(["movie", "tv"]);

export const listLists = createServerFn({ method: "GET" })
  .middleware([requireUser])
  .handler(async ({ context }) => lists.listListsWithPreview(context.userId));

export const getList = createServerFn({ method: "GET" })
  .middleware([requireUser])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => lists.getListWithItems(context.userId, data.id));

export const createList = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .inputValidator((d: unknown) =>
    z.object({
      name: z.string().trim().min(1).max(120),
      description: z.string().trim().max(2000).optional().nullable(),
    }).parse(d),
  )
  .handler(async ({ data, context }) =>
    tracked.trackedCreateList(context.userId, data.name, data.description ?? null),
  );

export const updateList = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .inputValidator((d: unknown) =>
    z.object({
      id: z.string().uuid(),
      name: z.string().trim().min(1).max(120).optional(),
      description: z.string().trim().max(2000).nullable().optional(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { id, ...patch } = data;
    return tracked.trackedUpdateList(context.userId, id, patch);
  });

export const deleteList = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    tracked.trackedDeleteList(context.userId, data.id);
    return { ok: true };
  });

export const addToList = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .inputValidator((d: unknown) =>
    z.object({
      listId: z.string().uuid(),
      mediaType: MediaKind,
      tmdbId: z.number().int().positive(),
      title: z.string().min(1).max(500),
      posterPath: z.string().nullable().optional(),
      backdropPath: z.string().nullable().optional(),
      releaseDate: z.string().nullable().optional(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    tracked.trackedAddToList(context.userId, data);
    return { ok: true };
  });

export const removeFromList = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .inputValidator((d: unknown) =>
    z.object({
      listId: z.string().uuid(),
      mediaType: MediaKind,
      tmdbId: z.number().int().positive(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    tracked.trackedRemoveFromList(context.userId, data.listId, data.mediaType, data.tmdbId);
    return { ok: true };
  });

/**
 * Takes several titles out of one list at once (a list's Select mode). Each is noted for Sync as its own removal,
 * exactly as removing them one at a time would be. All or none: one database transaction.
 */
export const removeManyFromList = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .inputValidator((d: unknown) =>
    z.object({
      listId: z.string().uuid(),
      items: z
        .array(z.object({ mediaType: MediaKind, tmdbId: z.number().int().positive() }))
        .min(1)
        .max(5000),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    transaction(() => {
      for (const it of data.items) tracked.trackedRemoveFromList(context.userId, data.listId, it.mediaType, it.tmdbId);
    });
    return { removed: data.items.length };
  });

/**
 * ⋮ > Import from MDBList: adds every title on an MDBList list (pasted link) to this list. Titles already on it stay
 * as they are. Each new one is noted for Sync like a normal add. A problem the user can act on (bad link, private
 * list, daily limit) comes back as `problem` rather than an error, so its wording reaches the screen.
 */
export const importFromMdblist = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .inputValidator((d: unknown) =>
    z.object({ listId: z.string().uuid(), url: z.string().trim().min(1).max(500) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    try {
      return { ok: true as const, ...(await importMdblistList(context.userId, data.listId, data.url)) };
    } catch (e) {
      if (e instanceof ImportProblem) return { ok: false as const, problem: e.message };
      throw e;
    }
  });

/**
 * Import > List of titles, step 1: matches pasted movie titles (one per line) to TMDB films. Changes nothing; the
 * person checks the matches, picks where unsure, then step 2 adds them. See title-match.server.ts for the rules.
 */
export const matchMovieTitles = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .inputValidator((d: unknown) => z.object({ text: z.string().max(100_000) }).parse(d))
  .handler(async ({ data }) => matchTitles(data.text));

/**
 * Import > List of titles, step 2: adds the chosen films to the list. Ones already on it stay as they are; each new
 * one is noted for Sync like a normal add. All or none: one database transaction.
 */
export const addMoviesToList = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .inputValidator((d: unknown) =>
    z.object({
      listId: z.string().uuid(),
      items: z
        .array(
          z.object({
            tmdbId: z.number().int().positive(),
            title: z.string().min(1).max(500),
            posterPath: z.string().max(200).nullable(),
            backdropPath: z.string().max(200).nullable(),
            releaseDate: z.string().max(20).nullable(),
          }),
        )
        .min(1)
        .max(TITLE_IMPORT_MAX_LINES),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const onList = new Set(lists.listItemKeys(context.userId, data.listId));
    const fresh = [...new Map(data.items.map((it) => [it.tmdbId, it])).values()].filter(
      (it) => !onList.has(`movie:${it.tmdbId}`),
    );
    transaction(() => {
      for (const it of fresh) tracked.trackedAddToList(context.userId, { listId: data.listId, mediaType: "movie", ...it });
    });
    return { added: fresh.length, alreadyThere: data.items.length - fresh.length };
  });

export const getListsContainingItem = createServerFn({ method: "GET" })
  .middleware([requireUser])
  .inputValidator((d: unknown) =>
    z.object({ mediaType: MediaKind, tmdbId: z.number().int().positive() }).parse(d),
  )
  .handler(async ({ data, context }) =>
    lists.getListsContainingItem(context.userId, data.mediaType, data.tmdbId),
  );

export const getListMembership = createServerFn({ method: "GET" })
  .middleware([requireUser])
  .handler(async ({ context }) => lists.listedItemKeys(context.userId));
