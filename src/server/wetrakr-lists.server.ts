/**
 * Reading what is on one of the user's WeTrakr lists. Used by Import, Compare and Sync.
 *
 * WeTrakr's docs do not show what a list item looks like, so an item is read whichever way it comes:
 * flat ({ type, ids }) or nested ({ movie: {...} } / { show: {...} }), with "movie"/"movies",
 * "show"/"shows"/"tv" as its type. The list is also read once by movies and once by shows
 * (/lists/{id}/items/movies and /shows), where the path says what each item is, and both reads are
 * merged: a title found by either is on the list.
 */
import { logInfo, redactText } from "./redact.server.ts";
import type { MediaKind } from "./types.ts";
import type { WtTitle } from "./wetrakr-import.server.ts";

const KINDS: Record<string, MediaKind> = {
  movie: "movie",
  movies: "movie",
  show: "tv",
  shows: "tv",
  tv: "tv",
};
/** Types a list can also hold that have no place in Popcornhour's lists. */
const OTHER = new Set(["season", "seasons", "episode", "episodes", "person", "people"]);

type Row = Record<string, unknown>;
const obj = (v: unknown): Row | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : null;
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** One list row as a movie or show, `"other"` for a season / episode / person, or null if it cannot be read. */
export function listItemOf(
  raw: unknown,
  hint?: MediaKind,
): { kind: MediaKind; item: WtTitle } | "other" | null {
  const r = obj(raw);
  if (!r) return null;
  const media0 = obj(r.media);
  const type = String(
    r.type ?? r.target ?? r.media_type ?? media0?.type ?? media0?.media_type ?? "",
  ).toLowerCase();
  let kind: MediaKind | null = hint ?? null;
  if (!kind) {
    if (KINDS[type]) kind = KINDS[type];
    else if (OTHER.has(type)) return "other";
    else if (obj(r.movie)) kind = "movie";
    else if (obj(r.show)) kind = "tv";
  }
  if (!kind) return null;
  const media = (kind === "movie" ? obj(r.movie) : obj(r.show)) ?? media0 ?? r;
  const ids = obj(media.ids);
  const t = ids?.tmdb ?? media.tmdb_id ?? media.tmdb;
  const tmdb =
    typeof t === "number" ? t : typeof t === "string" && /^\d+$/.test(t) ? Number(t) : null;
  if (tmdb === null) return null;
  return {
    kind,
    item: {
      type: kind === "movie" ? "movie" : "show",
      ids: { tmdb },
      title: str(media.title) ?? str(media.name),
      release_date: str(media.release_date) ?? null,
      first_air_date: str(media.first_air_date) ?? null,
    },
  };
}

export type WetrakrListItems = {
  /** By "movie:<tmdb>" / "tv:<tmdb>". */
  items: Map<string, { kind: MediaKind; item: WtTitle }>;
  /** Rows of the all-types read that were neither a movie/show (found by either read) nor a season/episode/person. */
  unreadable: number;
  /** Seasons, episodes and people on the list. */
  other: number;
};

/** Every movie and show on one WeTrakr list. `getAll` reads every page of a path. */
export async function readWetrakrListItems(
  getAll: (path: string) => Promise<unknown[]>,
  listId: string | number,
): Promise<WetrakrListItems> {
  const out: WetrakrListItems = { items: new Map(), unreadable: 0, other: 0 };
  const put = (got: { kind: MediaKind; item: WtTitle }) => {
    const k = `${got.kind}:${got.item.ids!.tmdb}`;
    if (!out.items.has(k)) out.items.set(k, got);
  };
  const all = await getAll(`/sync/lists/${listId}/items`);
  const rows = all.length;
  for (const row of all) {
    const got = listItemOf(row);
    if (got === "other") out.other++;
    else if (got) put(got);
    else out.unreadable++;
  }
  // The same list by type. Failing here is not fatal: the read above stands.
  for (const [target, kind] of [
    ["movies", "movie"],
    ["shows", "tv"],
  ] as const) {
    try {
      for (const row of await getAll(`/lists/${listId}/items/${target}`)) {
        const got = listItemOf(row, kind);
        if (got && got !== "other") put(got);
      }
    } catch (e) {
      logInfo(
        `[wetrakr-lists] list ${listId} ${target} not read by type: ${redactText(e instanceof Error ? e.message : String(e))}`,
      );
    }
  }
  if (out.unreadable) {
    logInfo(
      `[wetrakr-lists] list ${listId}: ${out.unreadable} rows of the all-types read could not be read`,
    );
    // Rows the read by type found anyway are not lost: count only what neither read accounts for.
    out.unreadable = Math.max(0, rows - out.other - out.items.size);
  }
  return out;
}
