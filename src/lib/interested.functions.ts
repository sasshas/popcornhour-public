/**
 * "<name> is interested": a one-tap toggle on a movie's or show's page that puts the title on (or takes it off) one
 * ordinary list, so the person you watch with can flag what they'd like to see together. The name comes from
 * WATCH_TOGETHER_NAME; with none set the button is hidden. The list is found by its name ("Jess is interested")
 * and made the first time something is added, through the same tracked calls as the Lists page, so Sync sends it
 * to Trakt / WeTrakr like any other list. Renaming the list on the Lists page means the button makes a new one.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireUser } from "@/lib/auth-middleware";
import { transaction } from "@/server/db";
import * as lists from "@/server/lists.server";
import * as tracked from "@/server/sync-changes.server";

const MediaKind = z.enum(["movie", "tv"]);

function partnerName(): string | null {
  const n = process.env.WATCH_TOGETHER_NAME?.trim();
  return n ? n.slice(0, 100) : null;
}
const listName = (name: string) => `${name} is interested`;

/** The partner's name (null: feature off), their list's id once it exists, and whether this title is on it. */
export const getInterested = createServerFn({ method: "GET" })
  .middleware([requireUser])
  .inputValidator((d: unknown) =>
    z.object({ mediaType: MediaKind, tmdbId: z.number().int().positive() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const name = partnerName();
    if (!name) return { name: null, listId: null, isIn: false };
    const listId = lists.findListIdByName(context.userId, listName(name));
    const isIn =
      !!listId &&
      lists.getListsContainingItem(context.userId, data.mediaType, data.tmdbId).includes(listId);
    return { name, listId, isIn };
  });

/** Every title on the partner's list ("movie:123"), for the people badge on posters; empty with the feature off. */
export const getInterestedKeys = createServerFn({ method: "GET" })
  .middleware([requireUser])
  .handler(async ({ context }) => {
    const name = partnerName();
    const listId = name ? lists.findListIdByName(context.userId, listName(name)) : null;
    return { name, keys: listId ? lists.listItemKeys(context.userId, listId) : [] };
  });

export const setInterested = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .inputValidator((d: unknown) =>
    z
      .object({
        interested: z.boolean(),
        mediaType: MediaKind,
        tmdbId: z.number().int().positive(),
        title: z.string().min(1).max(500),
        posterPath: z.string().nullable().optional(),
        backdropPath: z.string().nullable().optional(),
        releaseDate: z.string().nullable().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const name = partnerName();
    if (!name) throw new Error("WATCH_TOGETHER_NAME is not set");
    const { interested, ...item } = data;
    // One transaction, so two quick taps can't make the list twice.
    return transaction(() => {
      let listId = lists.findListIdByName(context.userId, listName(name));
      if (!interested) {
        if (listId)
          tracked.trackedRemoveFromList(context.userId, listId, item.mediaType, item.tmdbId);
        return { isIn: false };
      }
      listId ??= tracked.trackedCreateList(
        context.userId,
        listName(name),
        `Titles ${name} would like to watch together. Filled by the "${listName(name)}" button on a title's page.`,
      ).id;
      tracked.trackedAddToList(context.userId, { listId, ...item });
      return { isIn: true };
    });
  });
