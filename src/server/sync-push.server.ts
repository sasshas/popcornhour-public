/**
 * Sync (this app -> Trakt / WeTrakr): the preview and the push.
 *
 * The services are the source of truth, so this is deliberately narrow:
 *  - Only the rows in sync_changes are sent (changes made in this app). Never the whole library.
 *  - A show is never sent as "watched". Shows only ever go out as single, named episodes, and
 *    every request is checked for that just before it is sent (assertNoWholeShow).
 *  - Before anything is sent, the service is asked what it already has, and changes it already
 *    has are dropped instead of being sent a second time.
 *  - One request per change, so each one either worked or is still waiting; at most MAX_PER_SYNC
 *    changes in one go.
 *
 * The service is reached through a small `Remote` object so the whole flow can be run against a
 * fake one in tests.
 */
import {
  deleteSyncChanges, listDescription, listNamesFor, listSyncChanges, type ShowStatus, type SyncChange, type SyncService,
} from "./sync-changes.server.ts";
import { getLibraryItem } from "./library.server.ts";
import { logError, logInfo, redactText } from "./redact.server.ts";
import { readWetrakrListItems } from "./wetrakr-lists.server.ts";
import { isUnknownWatchedAt } from "@/lib/watched-date";
import type { ProgressEvent } from "./trakt-import.server.ts";

export type { SyncService };
export const MAX_PER_SYNC = 50;
const NAME: Record<SyncService, string> = { trakt: "Trakt", wetrakr: "WeTrakr" };

export type Remote = {
  get<T>(path: string): Promise<T>;
  /** Every page of a list. `onPage` (WeTrakr only) hears about each page as it arrives. */
  getAll<T>(path: string, onPage?: (page: number, pageCount: number) => void): Promise<T[]>;
  /** `key` identifies this one change, so a retried request is not applied twice (WeTrakr). */
  post<T>(path: string, body: unknown, key: string): Promise<T>;
  /** PUT / DELETE (lists). Answers null when the service sends no body. */
  write<T>(method: "PUT" | "DELETE", path: string, body: unknown, key: string): Promise<T | null>;
};

export type PreviewItem = {
  id: string;
  kind: SyncChange["kind"];
  mediaType: "movie" | "tv";
  tmdbId: number;
  title: string;
  season: number | null;
  episode: number | null;
  watchedAt: string | null;
  /** watchlist / favourite / list item / list: 1 add, 0 remove. rating: the rating, null = remove. */
  value: number | null;
  status: ShowStatus | null;
  listName: string | null;
  prevName: string | null;
  /** Takes something away on the service. */
  removal: boolean;
  /** Why this one will not be sent (the service already has it, or cannot take it). */
  skip: string | null;
};

export function isRemoval(c: Pick<SyncChange, "kind" | "value">): boolean {
  if (c.kind === "unwatch" || c.kind === "unplay") return true;
  if (c.kind === "rating") return c.value === null;
  if (c.kind === "watchlist" || c.kind === "favorite" || c.kind === "list" || c.kind === "list_item") return c.value === 0;
  return false;
}

const isEpisode = (c: SyncChange) => c.media_type === "tv" && c.season_number != null && c.episode_number != null;
const minute = (iso: string | null | undefined) => (iso && !Number.isNaN(Date.parse(iso)) ? Math.floor(Date.parse(iso) / 60_000) : null);

// ---------- what the service already has ----------

type RemotePlays = Map<string, number[]>; // key -> the minutes of the plays the service has

function addPlay(map: RemotePlays, key: string, at: string | null | undefined) {
  const m = minute(at);
  const list = map.get(key) ?? [];
  if (m !== null) list.push(m);
  map.set(key, list);
}

/** The day before the earliest episode watch waiting to be sent: plays since then are enough to spot repeats. */
function earliestEpisodeDay(changes: SyncChange[]): string | null {
  const times = changes
    // A watch with no date (kept as 1970) is left out, or the whole episode history would be read.
    .filter((c) => c.kind === "watch" && isEpisode(c) && c.watched_at && !isUnknownWatchedAt(c.watched_at))
    .map((c) => Date.parse(c.watched_at!))
    .filter((t) => !Number.isNaN(t));
  if (!times.length) return null;
  return new Date(Math.min(...times) - 24 * 3600 * 1000).toISOString();
}

type RemoteState = {
  moviePlays: RemotePlays | null;
  episodePlays: RemotePlays | null;
  /** WeTrakr only: shows that already sit on one of its lists other than the watchlist. */
  trackedShows: Set<number> | null;
};

async function readRemoteState(service: SyncService, remote: Remote, changes: SyncChange[]): Promise<RemoteState> {
  const state: RemoteState = { moviePlays: null, episodePlays: null, trackedShows: null };
  const movieWatch = changes.some((c) => c.kind === "watch" && c.media_type === "movie");
  const since = earliestEpisodeDay(changes);

  if (service === "trakt") {
    if (movieWatch) {
      const rows = await remote.get<{ last_watched_at?: string; movie?: { ids?: { tmdb?: number } } }[]>("/sync/watched/movies");
      state.moviePlays = new Map();
      for (const r of rows) if (r.movie?.ids?.tmdb) addPlay(state.moviePlays, `${r.movie.ids.tmdb}`, r.last_watched_at);
    }
    if (since) {
      const rows = await remote.getAll<{
        watched_at?: string;
        episode?: { season?: number; number?: number };
        show?: { ids?: { tmdb?: number } };
      }>(`/sync/history/episodes?start_at=${encodeURIComponent(since)}`);
      state.episodePlays = new Map();
      for (const r of rows) {
        if (r.show?.ids?.tmdb == null || r.episode?.season == null || r.episode?.number == null) continue;
        addPlay(state.episodePlays, `${r.show.ids.tmdb}:${r.episode.season}:${r.episode.number}`, r.watched_at);
      }
    }
    return state;
  }

  // WeTrakr. Putting a title on its watchlist MOVES it there, off Watched / Watching, so the
  // watched movies and the show lists are also read whenever a watchlist add is waiting.
  const movieListAdd = changes.some((c) => c.kind === "watchlist" && c.value === 1 && c.media_type === "movie");
  const showListAdd = changes.some((c) => c.kind === "watchlist" && c.value === 1 && c.media_type === "tv");
  if (movieWatch || movieListAdd) {
    const rows = await remote.getAll<{ ids?: { tmdb?: number }; watched_at?: string }>("/sync/tracking/watched/movies");
    state.moviePlays = new Map();
    for (const r of rows) if (r.ids?.tmdb) addPlay(state.moviePlays, `${r.ids.tmdb}`, r.watched_at);
  }
  if (since) {
    const rows = await remote.getAll<{
      watched_at?: string;
      episode?: { season_number?: number; number?: number; show?: { ids?: { tmdb?: number } } };
    }>(`/sync/tracking/watched/history/episodes?watched_from=${encodeURIComponent(since)}`);
    state.episodePlays = new Map();
    for (const r of rows) {
      const e = r.episode;
      if (e?.show?.ids?.tmdb == null || e.season_number == null || e.number == null) continue;
      addPlay(state.episodePlays, `${e.show.ids.tmdb}:${e.season_number}:${e.number}`, r.watched_at);
    }
  }
  if (showListAdd) {
    state.trackedShows = new Set();
    for (const list of ["watched", "waiting", "watching", "paused", "dropped"]) {
      const rows = await remote.getAll<{ ids?: { tmdb?: number } }>(`/sync/tracking/${list}/shows`);
      for (const r of rows) if (r.ids?.tmdb) state.trackedShows.add(r.ids.tmdb);
    }
  }
  return state;
}

/** Why a change should not be sent, or null when it should. */
function skipReason(userId: string, service: SyncService, c: SyncChange, state: RemoteState): string | null {
  if (c.kind === "watch") {
    const plays = isEpisode(c)
      ? state.episodePlays?.get(`${c.tmdb_id}:${c.season_number}:${c.episode_number}`)
      : state.moviePlays?.get(`${c.tmdb_id}`);
    if (plays) {
      const mine = minute(c.watched_at);
      // A first watch the service already knows about, or the very same play: sending it would add a repeat.
      if (c.first_watch === 1 || (mine !== null && plays.includes(mine))) return `Already watched on ${NAME[service]}`;
    }
    return null;
  }
  if (service === "trakt" && c.kind === "status" && c.status !== "dropped" && c.prev_status !== "dropped") {
    return "Trakt has no Paused";
  }
  if (service === "wetrakr" && c.kind === "watchlist" && c.value === 1) {
    if (c.media_type === "movie") {
      const local = getLibraryItem(userId, "movie", c.tmdb_id);
      if (local?.status === "completed" || state.moviePlays?.has(`${c.tmdb_id}`)) {
        return "Watched, and WeTrakr cannot keep a watched title on the watchlist";
      }
    } else if (state.trackedShows?.has(c.tmdb_id)) {
      return "Already on one of your WeTrakr show lists";
    }
  }
  return null;
}

function toItem(c: SyncChange, skip: string | null): PreviewItem {
  return {
    id: c.id,
    kind: c.kind,
    mediaType: c.media_type,
    tmdbId: c.tmdb_id,
    title: c.title,
    season: c.season_number,
    episode: c.episode_number,
    watchedAt: c.watched_at,
    value: c.value,
    status: c.status,
    listName: c.list_name,
    prevName: c.prev_name,
    removal: isRemoval(c),
    skip,
  };
}

/** Everything waiting to be sent, checked against the service. Reads only: nothing is changed anywhere. */
export async function buildSyncPreview(userId: string, service: SyncService, remote: Remote): Promise<PreviewItem[]> {
  const changes = listSyncChanges(userId, service);
  if (!changes.length) return [];
  const state = await readRemoteState(service, remote, changes);
  return changes.map((c) => toItem(c, skipReason(userId, service, c, state)));
}

// ---------- the requests ----------

type Method = "POST" | "PUT" | "DELETE";
type Request = { method?: Method; path: string; body?: Record<string, unknown> };

/** The service's own id for each of its lists, by name (lists are matched by name, as the imports do). */
type ListIndex = Map<string, string>;

async function readLists(service: SyncService, remote: Remote): Promise<ListIndex> {
  const out: ListIndex = new Map();
  if (service === "trakt") {
    const rows = await remote.get<{ name?: string; ids?: { trakt?: number } }[]>("/users/me/lists");
    for (const r of rows) if (r.name && r.ids?.trakt != null && !out.has(r.name)) out.set(r.name, String(r.ids.trakt));
  } else {
    const rows = await remote.get<{ name?: string; id?: string | number }[]>("/sync/lists");
    for (const r of rows) if (r.name && r.id != null && !out.has(r.name)) out.set(r.name, String(r.id));
  }
  return out;
}

const listsBase = (service: SyncService) => (service === "trakt" ? "/users/me/lists" : "/sync/lists");

/** Find the service's list for a change, by the name it has there; optionally create it. */
async function resolveList(
  userId: string,
  service: SyncService,
  remote: Remote,
  lists: ListIndex,
  c: SyncChange,
  create: boolean,
): Promise<string | null> {
  const names = listNamesFor(userId, service, c.list_id);
  for (const n of [names.now, names.remote, c.list_name]) if (n && lists.has(n)) return lists.get(n)!;
  if (!create) return null;
  const name = names.now ?? c.list_name;
  if (!name) return null;
  const description = listDescription(userId, c.list_id);
  const body =
    service === "trakt"
      ? { name, description: description ?? "", privacy: "private" }
      : { name, ...(description ? { description } : {}) };
  const made = await remote.post<{ id?: string | number; ids?: { trakt?: number } }>(listsBase(service), body, `${c.id}:create`);
  const id = service === "trakt" ? made?.ids?.trakt : made?.id;
  logInfo(`[sync] ${service} created list -> ${id ?? "no id"}`);
  if (id == null) throw new Error(`${NAME[service]} did not return the new list`);
  lists.set(name, String(id));
  return String(id);
}

/** A rewatch's single play: Trakt needs its history id, found from the time it was watched. */
async function traktPlayIds(remote: Remote, c: SyncChange): Promise<number[]> {
  const at = Date.parse(c.watched_at ?? "");
  if (Number.isNaN(at)) return [];
  const from = new Date(at - 60_000).toISOString();
  const to = new Date(at + 60_000).toISOString();
  const kind = isEpisode(c) ? "episodes" : "movies";
  const rows = await remote.getAll<{
    id: number;
    movie?: { ids?: { tmdb?: number } };
    show?: { ids?: { tmdb?: number } };
    episode?: { season?: number; number?: number };
  }>(`/sync/history/${kind}?start_at=${encodeURIComponent(from)}&end_at=${encodeURIComponent(to)}`);
  return rows
    .filter((r) =>
      isEpisode(c)
        ? r.show?.ids?.tmdb === c.tmdb_id && r.episode?.season === c.season_number && r.episode?.number === c.episode_number
        : r.movie?.ids?.tmdb === c.tmdb_id,
    )
    .map((r) => r.id);
}

/** Build the request(s) for one change. Returns null when there is nothing to do on this service. */
async function requestsFor(
  userId: string,
  service: SyncService,
  remote: Remote,
  lists: () => Promise<ListIndex>,
  c: SyncChange,
): Promise<Request[] | null> {
  const ids = { tmdb: c.tmdb_id };
  const group = c.media_type === "movie" ? "movies" : "shows";
  const trakt = service === "trakt";
  const episodeBody = (extra: Record<string, unknown>) => ({
    shows: [{ ids, seasons: [{ number: c.season_number, episodes: [{ number: c.episode_number, ...extra }] }] }],
  });

  switch (c.kind) {
    case "watch":
    case "unwatch": {
      const add = c.kind === "watch";
      if (trakt) {
        const path = add ? "/sync/history" : "/sync/history/remove";
        // A watch with no date goes as Trakt's own "unknown" keyword, not as a 1970 date.
        const stamp = add ? { watched_at: isUnknownWatchedAt(c.watched_at) ? "unknown" : c.watched_at } : {};
        return [{ path, body: c.media_type === "movie" ? { movies: [{ ids, ...stamp }] } : episodeBody(stamp) }];
      }
      const path = add ? "/sync/tracking" : "/sync/tracking/remove/all";
      const stamp = add ? { tracked_at: c.watched_at } : {};
      // The status sits on the episode, never on the show: a show marked "watched" would mean every episode.
      return [{
        path,
        body: c.media_type === "movie" ? { movies: [{ ids, status: "watched", ...stamp }] } : episodeBody({ status: "watched", ...stamp }),
      }];
    }
    case "unplay": {
      if (trakt) {
        const playIds = await traktPlayIds(remote, c);
        return playIds.length ? [{ path: "/sync/history/remove", body: { ids: playIds.slice(0, 1) } }] : null;
      }
      const stamp = { status: "watched", tracked_at: c.watched_at };
      return [{
        path: "/sync/tracking/remove",
        body: c.media_type === "movie" ? { movies: [{ ids, ...stamp }] } : episodeBody(stamp),
      }];
    }
    case "watchlist":
      if (trakt) return [{ path: c.value === 1 ? "/sync/watchlist" : "/sync/watchlist/remove", body: { [group]: [{ ids }] } }];
      return [{ path: c.value === 1 ? "/sync/tracking" : "/sync/tracking/remove", body: { [group]: [{ ids, status: "planning" }] } }];
    case "rating":
      // One episode: the show, its season and the episode, by number. Both services take this nested form.
      if (isEpisode(c)) {
        return c.value === null
          ? [{ path: "/sync/ratings/remove", body: episodeBody({}) }]
          : [{ path: "/sync/ratings", body: episodeBody({ rating: c.value }) }];
      }
      return c.value === null
        ? [{ path: "/sync/ratings/remove", body: { [group]: [{ ids }] } }]
        : [{ path: "/sync/ratings", body: { [group]: [{ ids, rating: c.value }] } }];
    case "favorite":
      return [{ path: c.value === 1 ? "/sync/favorites" : "/sync/favorites/remove", body: { [group]: [{ ids }] } }];
    case "status": {
      if (c.media_type !== "tv") return null;
      if (trakt) {
        // Trakt only knows "dropped" (it hides the show from progress); it has no On hold.
        if (c.status === "dropped") return [{ path: "/users/hidden/dropped", body: { shows: [{ ids }] } }];
        if (c.prev_status === "dropped") return [{ path: "/users/hidden/dropped/remove", body: { shows: [{ ids }] } }];
        return null;
      }
      const status = c.status === "dropped" ? "dropped" : c.status === "on_hold" ? "paused" : "watching";
      return [{ path: "/sync/tracking", body: { shows: [{ ids, status }] } }];
    }
    case "list": {
      const index = await lists();
      if (c.value === 0) {
        const id = await resolveList(userId, service, remote, index, c, false);
        return id ? [{ method: "DELETE", path: `${listsBase(service)}/${id}` }] : null;
      }
      const names = listNamesFor(userId, service, c.list_id);
      const name = names.now ?? c.list_name ?? c.title;
      const existing = (names.remote && index.get(names.remote)) || index.get(name);
      const description = listDescription(userId, c.list_id);
      if (!existing) {
        await resolveList(userId, service, remote, index, c, true);
        return [];
      }
      if (names.remote && names.remote !== name) {
        index.delete(names.remote);
        index.set(name, existing);
      }
      return [{ method: "PUT", path: `${listsBase(service)}/${existing}`, body: { name, description: description ?? "" } }];
    }
    case "list_item": {
      const index = await lists();
      const id = await resolveList(userId, service, remote, index, c, c.value === 1);
      if (!id) return null;
      const path = `${listsBase(service)}/${id}/items${c.value === 1 ? "" : "/remove"}`;
      return [{ path, body: { [group]: [{ ids }] } }];
    }
  }
}

type ShowBody = { status?: unknown; seasons?: { status?: unknown; episodes?: unknown[] }[] };

/** Show lists a whole show may be moved to on WeTrakr: none of these marks or removes episodes. */
const SHOW_LIST_STATUSES = new Set(["planning", "dropped", "paused", "watching"]);

/**
 * Last line of defence, run on every request just before it is sent. On both services a show
 * with no episodes listed means "the whole show": watched or removed in one go. This app must
 * never send that, whatever bug put it in the queue.
 */
export function assertNoWholeShow(req: Request): void {
  const shows = ((req.body?.shows ?? []) as ShowBody[]);
  const touchesHistory = /\/sync\/(history|tracking)/.test(req.path);
  for (const s of shows) {
    const hasSeasons = Array.isArray(s.seasons) && s.seasons.length > 0;
    if (hasSeasons) {
      const explicit = s.seasons!.every((x) => x.status === undefined && Array.isArray(x.episodes) && x.episodes.length > 0);
      if (!explicit || s.status !== undefined) throw new Error("Refusing to send a show without explicit episodes");
    } else if (touchesHistory) {
      const ok =
        (req.path === "/sync/tracking" && SHOW_LIST_STATUSES.has(String(s.status))) ||
        (req.path === "/sync/tracking/remove" && s.status === "planning");
      if (!ok) throw new Error("Refusing to send a whole show");
    }
  }
}

/** True when an answer's "not found" / "errored" part lists anything. The exact shape differs per service. */
function hasEntries(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "number") return v > 0;
  if (v && typeof v === "object") return Object.values(v).some(hasEntries);
  return false;
}

type Outcome = "ok" | "notFound" | "refused";

async function send(
  userId: string,
  service: SyncService,
  remote: Remote,
  lists: () => Promise<ListIndex>,
  c: SyncChange,
): Promise<Outcome> {
  const reqs = await requestsFor(userId, service, remote, lists, c);
  if (reqs === null) {
    logInfo(`[sync] ${service} ${c.subject} -> nothing to do there`);
    return "notFound";
  }
  for (const [n, req] of reqs.entries()) {
    assertNoWholeShow(req);
    const key = n === 0 ? c.id : `${c.id}:${n}`;
    const res =
      req.method && req.method !== "POST"
        ? await remote.write<Record<string, unknown>>(req.method, req.path, req.body, key)
        : await remote.post<Record<string, unknown>>(req.path, req.body ?? {}, key);
    logInfo(`[sync] ${service} ${req.method ?? "POST"} ${req.path} ${c.subject} -> ${redactText(JSON.stringify(res ?? null).slice(0, 300))}`);
    if (hasEntries(res?.not_found) || hasEntries(res?.notFound)) return "notFound";
    if (hasEntries(res?.errored)) {
      // WeTrakr answers a removal of something that is not there with "errored": that is the wanted end state.
      if (isRemoval(c)) return "ok";
      // A list add can be refused because the title is already on that list: look before calling it refused.
      const listId = service === "wetrakr" && c.kind === "list_item" ? /^\/sync\/lists\/([^/]+)\/items$/.exec(req.path)?.[1] : undefined;
      if (listId) {
        const read = await readWetrakrListItems((path) => remote.getAll<unknown>(path), listId);
        if (read.items.has(`${c.media_type}:${c.tmdb_id}`)) {
          logInfo(`[sync] ${service} ${c.subject} -> already on that list`);
          return "ok";
        }
      }
      return "refused";
    }
  }
  return "ok";
}

/** Lists are created or renamed first (so items find them), then removals, then everything else. */
function order(c: SyncChange): number {
  if (c.kind === "list" && c.value === 1) return 0;
  if (isRemoval(c)) return 1;
  return 2;
}

/**
 * Send the chosen changes. A change leaves the queue once the service has taken it (or says the
 * title does not exist there); anything that failed stays for the next sync.
 */
export async function* runSyncPush(
  userId: string,
  service: SyncService,
  remote: Remote,
  ids: string[],
): AsyncGenerator<ProgressEvent> {
  const summary = { sent: 0, removed: 0, alreadyThere: 0, notFound: 0, failed: 0 };
  try {
    yield { type: "phase", phase: "checking", total: 0 };
    const changes = listSyncChanges(userId, service);
    const state = await readRemoteState(service, remote, changes);

    // Changes the service already has (or can never take) are settled: drop them from the queue.
    const settled = changes.filter((c) => skipReason(userId, service, c, state) !== null);
    summary.alreadyThere = deleteSyncChanges(userId, settled.map((c) => c.id));

    const wanted = new Set(ids);
    const settledIds = new Set(settled.map((c) => c.id));
    const chosen = changes
      .filter((c) => wanted.has(c.id) && !settledIds.has(c.id))
      .slice(0, MAX_PER_SYNC)
      .sort((a, b) => order(a) - order(b));

    // The service's lists are read once, and only if a list change is being sent.
    let index: Promise<ListIndex> | null = null;
    const lists = () => (index ??= readLists(service, remote));

    yield { type: "phase", phase: "sending", total: chosen.length };
    let done = 0;
    for (const c of chosen) {
      let outcome: Outcome;
      try {
        outcome = await send(userId, service, remote, lists, c);
      } catch (e) {
        // The connection or the service itself failed: stop here, everything not sent is still waiting.
        logError(`Sync to ${NAME[service]} stopped`, e);
        summary.failed += chosen.length - done;
        logInfo(`[sync] ${service} stopped early: ${JSON.stringify(summary)}`);
        yield {
          type: "error",
          message:
            `${redactText(e instanceof Error ? e.message : "Sync failed")}. ` +
            `${summary.sent + summary.removed} sent before it stopped; the rest are still waiting.`,
        };
        return;
      }
      if (outcome === "refused") {
        summary.failed++;
      } else {
        deleteSyncChanges(userId, [c.id]);
        if (outcome === "notFound") summary.notFound++;
        else if (isRemoval(c)) summary.removed++;
        else summary.sent++;
      }
      done++;
      yield { type: "progress", phase: "sending", current: done, total: chosen.length };
    }
    logInfo(`[sync] ${service} finished: ${JSON.stringify(summary)}`);
    yield { type: "done", summary };
  } catch (e) {
    logError(`Sync to ${NAME[service]} failed`, e);
    yield { type: "error", message: redactText(e instanceof Error ? e.message : "Sync failed") };
  }
}
