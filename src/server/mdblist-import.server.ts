/**
 * Import an MDBList list (https://mdblist.com/lists/<user>/<list>) into one of your lists.
 *
 * MDBList gives each title's TMDB id, name and release date (`GET /lists/<user>/<slug>/items`, up to 1,000 per
 * request; checked against the live API 2026-11-20). Titles already on your list are left as they are. New ones are
 * added the same way as tapping "Add to list" (trackedAddToList), so Sync sends them to Trakt / WeTrakr too.
 * Posters: taken from the same title elsewhere in your library or lists when known, else looked up on TMDB.
 * Uses the MDBLIST_API_KEY that also supplies Rotten Tomatoes scores; each 1,000 titles costs one of its 1,000
 * lookups a day.
 */
import { getDb } from "./db.ts";
import * as lists from "./lists.server.ts";
import { logError } from "./redact.server.ts";
import { trackedAddToList } from "./sync-changes.server.ts";
import type { MediaKind } from "./types.ts";

/** Biggest list imported in one go; MDBList lists can be far larger than anyone browses. */
export const MDBLIST_IMPORT_MAX = 5000;
const PAGE = 1000;

export type MdblistListRef = { kind: "slug"; user: string; slug: string } | { kind: "id"; id: number };

/**
 * Reads the list out of what was pasted: "https://mdblist.com/lists/<user>/<list>" (with or without https://, www.,
 * a trailing slash or ?query), "<user>/<list>", or a list number ("https://mdblist.com/lists/14").
 * null when it isn't an MDBList list link. Only plain names are accepted, so nothing odd ends up in the API path.
 */
export function parseMdblistUrl(input: string): MdblistListRef | null {
  let s = input.trim();
  if (!s) return null;
  if (/^(https?:\/\/)?(www\.)?mdblist\.com\//i.test(s)) {
    const url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    s = url.pathname;
    const m = /^\/lists\/(.+?)\/?$/.exec(s);
    if (!m) return null;
    s = m[1];
  }
  s = s.replace(/^\/+|\/+$/g, "");
  if (/^\d+$/.test(s)) return { kind: "id", id: Number(s) };
  const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(s);
  if (!m || m[1] === "." || m[1] === ".." || m[2] === "." || m[2] === "..") return null;
  return { kind: "slug", user: m[1], slug: m[2] };
}

export type MdblistItem = { mediaType: MediaKind; tmdbId: number; title: string; releaseDate: string | null };

type RawItem = { id?: unknown; ids?: { tmdb?: unknown }; title?: unknown; release_date?: unknown; release_year?: unknown };

/** One page of `/items` turned into titles. Entries without a TMDB id or a name are dropped (counted by the caller). */
export function parseMdblistItems(json: unknown): { items: MdblistItem[]; skipped: number; hasMore: boolean } {
  const j = (json ?? {}) as { movies?: unknown; shows?: unknown; pagination?: { has_more?: unknown } };
  const items: MdblistItem[] = [];
  let skipped = 0;
  const take = (arr: unknown, mediaType: MediaKind) => {
    if (!Array.isArray(arr)) return;
    for (const raw of arr as RawItem[]) {
      const id = raw?.ids?.tmdb ?? raw?.id;
      const title = typeof raw?.title === "string" ? raw.title.trim() : "";
      if (typeof id !== "number" || !Number.isInteger(id) || id <= 0 || !title) {
        skipped++;
        continue;
      }
      const date =
        typeof raw.release_date === "string" && /^\d{4}-\d{2}-\d{2}/.test(raw.release_date)
          ? raw.release_date.slice(0, 10)
          : typeof raw.release_year === "number" && raw.release_year > 1800
            ? String(raw.release_year)
            : null;
      items.push({ mediaType, tmdbId: id, title: title.slice(0, 500), releaseDate: date });
    }
  };
  take(j.movies, "movie");
  take(j.shows, "tv");
  return { items, skipped, hasMore: j.pagination?.has_more === true };
}

export class ImportProblem extends Error {}

async function fetchAllItems(ref: MdblistListRef, key: string): Promise<{ items: MdblistItem[]; skipped: number }> {
  const path =
    ref.kind === "id"
      ? `lists/${ref.id}/items`
      : `lists/${encodeURIComponent(ref.user)}/${encodeURIComponent(ref.slug)}/items`;
  const items: MdblistItem[] = [];
  let skipped = 0;
  for (let offset = 0; offset < MDBLIST_IMPORT_MAX; offset += PAGE) {
    // The key travels in the URL, so this URL is never logged.
    const res = await fetch(
      `https://api.mdblist.com/${path}?limit=${PAGE}&offset=${offset}&apikey=${encodeURIComponent(key)}`,
      { signal: AbortSignal.timeout(20000) },
    );
    if (res.status === 404) throw new ImportProblem("MDBList couldn't find that list. Check the link, or it may be private");
    if (res.status === 429) throw new ImportProblem("MDBList's daily limit is used up. Try again tomorrow");
    if (!res.ok) {
      logError("[mdblist import] list read failed", `HTTP ${res.status}`);
      throw new ImportProblem("MDBList didn't answer properly. Try again in a minute");
    }
    const page = parseMdblistItems(await res.json());
    items.push(...page.items);
    skipped += page.skipped;
    if (!page.hasMore || page.items.length + page.skipped === 0) break;
  }
  return { items, skipped };
}

/** A poster for each title already known elsewhere (your library or another list), so TMDB isn't asked again. */
function knownPosters(userId: string): Map<string, { poster: string; backdrop: string | null }> {
  const rows = getDb()
    .prepare(
      `SELECT media_type, tmdb_id, poster_path, backdrop_path FROM library_items WHERE user_id = ? AND poster_path IS NOT NULL
       UNION ALL
       SELECT media_type, tmdb_id, poster_path, backdrop_path FROM list_items WHERE user_id = ? AND poster_path IS NOT NULL`,
    )
    .all(userId, userId) as { media_type: string; tmdb_id: number; poster_path: string; backdrop_path: string | null }[];
  const m = new Map<string, { poster: string; backdrop: string | null }>();
  for (const r of rows) m.set(`${r.media_type}:${r.tmdb_id}`, { poster: r.poster_path, backdrop: r.backdrop_path });
  return m;
}

async function tmdbPoster(mediaType: MediaKind, tmdbId: number): Promise<{ poster: string | null; backdrop: string | null }> {
  const key = process.env.TMDB_API_KEY;
  if (!key) return { poster: null, backdrop: null };
  try {
    const res = await fetch(`https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${key}&language=en-US`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { poster: null, backdrop: null };
    const j = (await res.json()) as { poster_path?: string | null; backdrop_path?: string | null };
    return { poster: j.poster_path ?? null, backdrop: j.backdrop_path ?? null };
  } catch {
    return { poster: null, backdrop: null }; // "Refresh posters" in Settings can fill it in later
  }
}

export type MdblistImportResult = {
  /** Titles MDBList listed (after dropping ones without a TMDB id). */
  found: number;
  added: number;
  alreadyThere: number;
  /** Entries MDBList had no TMDB id for. */
  skipped: number;
  /** True when the list was longer than MDBLIST_IMPORT_MAX and only the first part was brought in. */
  cutOff: boolean;
};

export async function importMdblistList(userId: string, listId: string, url: string): Promise<MdblistImportResult> {
  const ref = parseMdblistUrl(url);
  if (!ref) throw new ImportProblem("That isn't an MDBList list link. It should look like mdblist.com/lists/name/list");
  const key = process.env.MDBLIST_API_KEY;
  if (!key) throw new ImportProblem("MDBList isn't set up on this server (MDBLIST_API_KEY is empty)");
  const owns = getDb().prepare(`SELECT 1 FROM lists WHERE id = ? AND user_id = ?`).get(listId, userId);
  if (!owns) throw new ImportProblem("List not found");

  const { items: raw, skipped } = await fetchAllItems(ref, key);
  // The same title twice in MDBList's answer counts once.
  const seen = new Set<string>();
  const items = raw.filter((it) => {
    const k = `${it.mediaType}:${it.tmdbId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const onList = new Set(lists.listItemKeys(userId, listId));
  const fresh = items.filter((it) => !onList.has(`${it.mediaType}:${it.tmdbId}`));

  // Posters first (network, outside the database transaction), a few at a time.
  const known = knownPosters(userId);
  const posters = new Map<string, { poster: string | null; backdrop: string | null }>();
  const toLookUp = fresh.filter((it) => {
    const k = `${it.mediaType}:${it.tmdbId}`;
    const hit = known.get(k);
    if (hit) posters.set(k, hit);
    return !hit;
  });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(10, toLookUp.length) }, async () => {
      while (next < toLookUp.length) {
        const it = toLookUp[next++];
        posters.set(`${it.mediaType}:${it.tmdbId}`, await tmdbPoster(it.mediaType, it.tmdbId));
      }
    }),
  );

  getDb().transaction(() => {
    for (const it of fresh) {
      const p = posters.get(`${it.mediaType}:${it.tmdbId}`);
      trackedAddToList(userId, {
        listId,
        mediaType: it.mediaType,
        tmdbId: it.tmdbId,
        title: it.title,
        posterPath: p?.poster ?? null,
        backdropPath: p?.backdrop ?? null,
        releaseDate: it.releaseDate,
      });
    }
  })();

  return {
    found: items.length,
    added: fresh.length,
    alreadyThere: items.length - fresh.length,
    skipped,
    cutOff: raw.length + skipped >= MDBLIST_IMPORT_MAX,
  };
}
