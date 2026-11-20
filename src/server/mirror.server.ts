/**
 * Compare with WeTrakr: the whole library here against the whole WeTrakr account, both ways.
 *
 *  - "send":   Popcornhour has it, WeTrakr does not -> add it on WeTrakr.
 *  - "bring":  WeTrakr has it, Popcornhour does not -> add it here (like Import: nothing queued for Sync).
 *  - "differ": both have the title but disagree (a rating, or Dropped / Paused) -> the user picks a side.
 *
 * Watches are compared play by play, so repeat watches count. Nothing is ever removed on either side,
 * except when the user settles a difference in watch dates: then the chosen side's dates replace the
 * other side's for that title. The comparison only reads; applying it recomputes the comparison first
 * and acts only on the entries the user ticked that are still there.
 * Shows only ever go to WeTrakr as named episodes (assertNoWholeShow guards every request).
 */
import { getDb, newId, nowIso, transaction } from "./db.ts";
import {
  importEpisodeProgress, importLibraryRows, setLibraryRating, type ImportLibraryRow,
} from "./library.server.ts";
import { readSetting, writeSetting } from "./backup.server.ts";
import { createList, findListIdByName, importListItems } from "./lists.server.ts";
import { addPlay, listPlays, removePlay, type PlayFilter } from "./plays.server.ts";
import { logError, logInfo, redactText } from "./redact.server.ts";
import { assertNoWholeShow, type Remote } from "./sync-push.server.ts";
import type { ProgressEvent } from "./trakt-import.server.ts";
import { toRating, type WtTitle } from "./wetrakr-import.server.ts";
import { readWetrakrListItems } from "./wetrakr-lists.server.ts";
import type { LibraryStatus, MediaKind } from "./types.ts";

// ---------- what each side has ----------

type Title = { title: string; release: string | null };
/** A show's place on WeTrakr, by the list it is on. */
type RemoteShowList = "watching" | "waiting" | "watched" | "paused" | "dropped";

export type RemoteSnapshot = {
  watchedMovies: Map<number, Title & { watchedAt: string | null }>;
  /** Every play of each movie (rewatches included), by TMDB id. null: watched, date unknown. */
  moviePlays: Map<number, (string | null)[]>;
  /** Shows on one of WeTrakr's show lists (not the watchlist). */
  shows: Map<number, Title & { list: RemoteShowList }>;
  planning: Map<string, Title>; // "movie:1" / "tv:1"
  /** Every play of each episode: "show:season:episode" -> dates. */
  episodePlays: Map<string, (string | null)[]>;
  showTitles: Map<number, string>;
  ratings: Map<string, Title & { rating: number }>;
  /** "show:season:episode" -> rating. */
  episodeRatings: Map<string, number>;
  /** null when WeTrakr would not say. */
  favorites: Map<string, Title> | null;
  /** Movies started and paused part-way on WeTrakr, with how far in (percent) when it says. */
  pausedMovies: Map<number, { title: string; progress: number | null }>;
  lists: { id: string; name: string; description: string | null; items: Map<string, Title & { mediaType: MediaKind; tmdbId: number }> }[];
};

/** One watch here: a row in plays (id set), or only the date on the title (a "stand-in", no id). */
export type LocalPlay = { at: string | null; id?: string };

export type LocalSnapshot = {
  library: {
    media_type: MediaKind; tmdb_id: number; title: string; release_date: string | null; status: LibraryStatus;
    watchlist: number; favorite: number; rating: number | null; watched_at: string | null;
  }[];
  /** Watched movies only. */
  moviePlays: Map<number, LocalPlay[]>;
  /** Ticked episodes only: "show:season:episode". */
  episodePlays: Map<string, LocalPlay[]>;
  episodeRatings: Map<string, number>;
  lists: { id: string; name: string; description: string | null; items: { media_type: MediaKind; tmdb_id: number; title: string; release_date: string | null }[] }[];
};

const SHOW_LISTS: RemoteShowList[] = ["dropped", "paused", "watching", "waiting", "watched"];

const key = (m: MediaKind, id: number) => `${m}:${id}`;
const day = (iso: string | null | undefined) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : null);

function titleOf(t: WtTitle, kind: MediaKind): Title {
  return { title: t.title || (kind === "tv" ? `Show ${t.ids?.tmdb}` : `Movie ${t.ids?.tmdb}`), release: day(kind === "movie" ? t.release_date : t.first_air_date) };
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

const okDate = (v: unknown): string | null => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null);

type WtEpisodeLike = {
  season_number?: number; season?: number; number?: number; watched_at?: string | null;
  show?: { title?: string; ids?: { tmdb?: number } };
  episode?: WtEpisodeLike;
  interactions?: { user?: { rating?: { rating?: number } } };
};

/** An episode as WeTrakr lists it, either flat or under `episode`: "show:season:episode", or null. */
function episodeKey(row: WtEpisodeLike): { k: string; tmdb: number; title?: string } | null {
  const e = row.episode ?? row;
  const show = e.show ?? row.show;
  const tmdb = show?.ids?.tmdb;
  const s = e.season_number ?? e.season;
  const n = e.number;
  if (typeof tmdb !== "number" || typeof s !== "number" || typeof n !== "number") return null;
  return { k: `${tmdb}:${s}:${n}`, tmdb, title: show?.title };
}

/** Where the reading of WeTrakr has got to: step (1-based) of steps, and the page within that step. */
export type ReadProgress = { step: number; steps: number; label: string; page: number; pages: number };

const READ_STEPS = [
  "Watched movies", "Movie watch history", "Show lists", "Watchlist", "Episode watch history", "Ratings",
  "Favourites", "Dropped movies", "Lists",
] as const;

function readStepFor(path: string): (typeof READ_STEPS)[number] {
  if (path.includes("/history/movies")) return "Movie watch history";
  if (path.includes("/history/episodes")) return "Episode watch history";
  if (path.endsWith("/watched/movies")) return "Watched movies";
  if (/\/(dropped|playing|paused)\/movies$/.test(path)) return "Dropped movies";
  if (path.includes("/planning/")) return "Watchlist";
  if (path.endsWith("/shows") && path.startsWith("/sync/tracking/")) return "Show lists";
  if (path.startsWith("/sync/ratings")) return "Ratings";
  if (path.startsWith("/sync/favorites")) return "Favourites";
  return "Lists";
}

export async function readRemote(remote: Remote, notes: string[], onProgress?: (p: ReadProgress) => void): Promise<RemoteSnapshot> {
  const tell = (path: string, page: number, pages: number) => {
    const label = readStepFor(path);
    onProgress?.({ step: READ_STEPS.indexOf(label) + 1, steps: READ_STEPS.length, label, page, pages });
  };
  const all = <T>(path: string) => {
    tell(path, 0, 0);
    return remote.getAll<T>(path, (page, pages) => tell(path, page, pages));
  };
  const snap: RemoteSnapshot = {
    watchedMovies: new Map(), moviePlays: new Map(), shows: new Map(), planning: new Map(), episodePlays: new Map(),
    showTitles: new Map(), ratings: new Map(), episodeRatings: new Map(), favorites: null, pausedMovies: new Map(), lists: [],
  };
  for (const m of await all<WtTitle>("/sync/tracking/watched/movies")) {
    const id = m.ids?.tmdb;
    if (typeof id === "number") snap.watchedMovies.set(id, { ...titleOf(m, "movie"), watchedAt: m.watched_at ?? null });
  }
  // One row per play, rewatches included.
  for (const p of await all<{ watched_at?: string | null; movie?: WtTitle }>("/sync/tracking/watched/history/movies")) {
    const id = p.movie?.ids?.tmdb;
    if (typeof id === "number") push(snap.moviePlays, id, okDate(p.watched_at));
  }
  // A watched movie the history did not list still counts as one watch.
  for (const [id, m] of snap.watchedMovies) if (!snap.moviePlays.has(id)) snap.moviePlays.set(id, [okDate(m.watchedAt)]);

  // The first list a show is found on wins; Dropped and Paused are read first.
  for (const list of SHOW_LISTS) {
    for (const s of await all<WtTitle>(`/sync/tracking/${list}/shows`)) {
      const id = s.ids?.tmdb;
      if (typeof id === "number" && !snap.shows.has(id)) snap.shows.set(id, { ...titleOf(s, "tv"), list });
    }
  }
  for (const kind of ["movie", "tv"] as const) {
    for (const t of await all<WtTitle>(`/sync/tracking/planning/${kind === "movie" ? "movies" : "shows"}`)) {
      if (typeof t.ids?.tmdb === "number") snap.planning.set(key(kind, t.ids.tmdb), titleOf(t, kind));
    }
  }
  for (const p of await all<WtEpisodeLike>("/sync/tracking/watched/history/episodes")) {
    const ep = episodeKey(p);
    if (!ep) continue;
    if (ep.title) snap.showTitles.set(ep.tmdb, ep.title);
    push(snap.episodePlays, ep.k, okDate(p.watched_at));
  }
  for (const kind of ["movie", "tv"] as const) {
    for (const t of await all<WtTitle>(`/sync/ratings/${kind === "movie" ? "movies" : "shows"}`)) {
      const r = toRating(t.interactions?.user?.rating?.rating);
      if (typeof t.ids?.tmdb === "number" && r !== null) snap.ratings.set(key(kind, t.ids.tmdb), { ...titleOf(t, kind), rating: r });
    }
  }
  for (const t of await all<WtEpisodeLike>("/sync/ratings/episodes")) {
    const ep = episodeKey(t);
    const r = toRating(t.interactions?.user?.rating?.rating);
    if (ep && r !== null) snap.episodeRatings.set(ep.k, r);
  }
  try {
    const favs = new Map<string, Title>();
    for (const kind of ["movie", "tv"] as const) {
      for (const t of await all<WtTitle>(`/sync/favorites/${kind === "movie" ? "movies" : "shows"}`)) {
        if (typeof t.ids?.tmdb === "number") favs.set(key(kind, t.ids.tmdb), titleOf(t, kind));
      }
    }
    snap.favorites = favs;
  } catch (e) {
    logError("Compare: WeTrakr favourites could not be read", e);
    notes.push("Favourites were not compared: WeTrakr did not list them.");
  }
  // WeTrakr can mark a movie Dropped; Popcornhour has no Dropped for movies, so these are only counted.
  try {
    const dropped = await all<WtTitle>("/sync/tracking/dropped/movies");
    if (dropped.length) {
      notes.push(
        `${dropped.length} movie${dropped.length === 1 ? " is" : "s are"} marked Dropped on WeTrakr. Popcornhour has no Dropped for movies, so ${dropped.length === 1 ? "it is" : "they are"} not compared.`,
      );
    }
  } catch (e) {
    logError("Compare: WeTrakr dropped movies could not be read", e);
  }
  // Movies started and paused part-way on WeTrakr ("playing", from a media player). That state sits
  // above the watchlist there: a watchlist add is taken but the movie stays paused. Read so a
  // watchlist add can clear it first. A "paused" movie list is read too, in case WeTrakr keeps one.
  for (const path of ["/sync/tracking/playing/movies", "/sync/tracking/paused/movies"]) {
    try {
      for (const t of await all<WtTitle & { playback?: { progress_percent?: number } }>(path)) {
        const id = t.ids?.tmdb;
        if (typeof id !== "number" || snap.pausedMovies.has(id)) continue;
        const pct = t.playback?.progress_percent;
        snap.pausedMovies.set(id, { title: titleOf(t, "movie").title, progress: typeof pct === "number" ? Math.round(pct) : null });
      }
    } catch (e) {
      logInfo(`[mirror] ${path} not read: ${redactText(e instanceof Error ? e.message : String(e))}`);
    }
  }
  if (snap.pausedMovies.size) {
    const names = [...snap.pausedMovies.values()].map((m) => m.title);
    notes.push(
      `Paused part-way on WeTrakr: ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""}. ` +
        "Popcornhour has no paused part-way for movies; one on your watchlist here has its playback cleared on WeTrakr when it is sent.",
    );
  }
  tell("/sync/lists", 0, 0);
  const lists = await remote.get<{ id: number | string; name?: string; description?: string | null; locked?: boolean }[]>("/sync/lists");
  for (const l of lists) {
    if (!l.name || l.locked) continue;
    const items = new Map<string, Title & { mediaType: MediaKind; tmdbId: number }>();
    const read = await readWetrakrListItems((path) => all<unknown>(path), l.id);
    for (const [k, { kind, item }] of read.items) {
      items.set(k, { ...titleOf(item, kind), mediaType: kind, tmdbId: item.ids!.tmdb! });
    }
    if (read.unreadable) {
      notes.push(`${read.unreadable} item${read.unreadable === 1 ? "" : "s"} on your WeTrakr list “${l.name}” could not be read, so ${read.unreadable === 1 ? "it was" : "they were"} not compared.`);
    }
    snap.lists.push({ id: String(l.id), name: l.name, description: l.description ?? null, items });
  }
  return snap;
}

export function readLocal(userId: string): LocalSnapshot {
  const db = getDb();
  const library = db
    .prepare(
      `SELECT media_type, tmdb_id, title, release_date, status, watchlist, favorite, rating, watched_at
         FROM library_items WHERE user_id = ?`,
    )
    .all(userId) as LocalSnapshot["library"];
  const playRows = db
    .prepare(`SELECT id, media_type, tmdb_id, season_number, episode_number, watched_at FROM plays WHERE user_id = ?`)
    .all(userId) as { id: string; media_type: MediaKind; tmdb_id: number; season_number: number | null; episode_number: number | null; watched_at: string }[];
  const rowsByMovie = new Map<number, LocalPlay[]>();
  const rowsByEpisode = new Map<string, LocalPlay[]>();
  for (const p of playRows) {
    if (p.media_type === "movie") push(rowsByMovie, p.tmdb_id, { at: okDate(p.watched_at), id: p.id });
    else if (p.season_number != null && p.episode_number != null) {
      push(rowsByEpisode, `${p.tmdb_id}:${p.season_number}:${p.episode_number}`, { at: okDate(p.watched_at), id: p.id });
    }
  }
  // A watched title's plays are its play rows, or, with none, the date on the title itself.
  const moviePlays = new Map<number, LocalPlay[]>();
  for (const r of library) {
    if (r.media_type !== "movie" || r.status !== "completed") continue;
    moviePlays.set(r.tmdb_id, rowsByMovie.get(r.tmdb_id) ?? [{ at: okDate(r.watched_at) }]);
  }
  const episodePlays = new Map<string, LocalPlay[]>();
  const episodeRatings = new Map<string, number>();
  const eps = db
    .prepare(`SELECT tv_tmdb_id, season_number, episode_number, watched_at, rating FROM episode_progress WHERE user_id = ?`)
    .all(userId) as { tv_tmdb_id: number; season_number: number; episode_number: number; watched_at: string; rating: number | null }[];
  for (const e of eps) {
    const k = `${e.tv_tmdb_id}:${e.season_number}:${e.episode_number}`;
    episodePlays.set(k, rowsByEpisode.get(k) ?? [{ at: okDate(e.watched_at) }]);
    if (e.rating != null) episodeRatings.set(k, e.rating);
  }
  const lists = (db.prepare(`SELECT id, name, description FROM lists WHERE user_id = ? ORDER BY created_at`).all(userId) as {
    id: string; name: string; description: string | null;
  }[]).map((l) => ({
    ...l,
    items: db
      .prepare(`SELECT media_type, tmdb_id, title, release_date FROM list_items WHERE list_id = ? ORDER BY position, added_at`)
      .all(l.id) as LocalSnapshot["lists"][number]["items"],
  }));
  return { library, moviePlays, episodePlays, episodeRatings, lists };
}

const minuteOf = (at: string | null) => (at ? Math.floor(Date.parse(at) / 60_000) : null);

/**
 * Line up the plays of one title on both sides: same minute = the same watch. A play with no date
 * (watched, date unknown) lines up with any one play left over on the other side.
 * ul / ur: the plays only here / only on WeTrakr.
 */
export function matchPlays(L: LocalPlay[], R: (string | null)[]): { ul: LocalPlay[]; ur: (string | null)[] } {
  const ul = [...L];
  const ur = [...R];
  for (let i = ul.length - 1; i >= 0; i--) {
    const m = minuteOf(ul[i].at);
    if (m === null) continue;
    const j = ur.findIndex((at) => minuteOf(at) === m);
    if (j >= 0) {
      ul.splice(i, 1);
      ur.splice(j, 1);
    }
  }
  // Undated plays on either side take one leftover play from the other.
  for (let i = ul.length - 1; i >= 0 && ur.length; i--) {
    if (ul[i].at !== null) continue;
    ul.splice(i, 1);
    ur.splice(0, 1);
  }
  for (let j = ur.length - 1; j >= 0 && ul.length; j--) {
    if (ur[j] !== null) continue;
    ur.splice(j, 1);
    ul.splice(0, 1);
  }
  return { ul, ur };
}

const latest = (ats: (string | null)[]) =>
  ats.reduce<string | null>((best, at) => (at && (!best || Date.parse(at) > Date.parse(best)) ? at : best), null);
const timesText = (word: string, n: number) => (n > 1 ? `${word} ${n} times` : word);
const moreText = (plays: number, episodes?: number) =>
  `${plays} more watch${plays === 1 ? "" : "es"}` + (episodes && episodes > 1 ? ` of ${episodes} episodes` : "");

// ---------- the comparison ----------

export type MirrorDirection = "send" | "bring" | "differ";
export type MirrorKind =
  | "movie" | "episodes" | "rewatch" | "dates" | "show" | "watchlist" | "status" | "rating" | "eprating" | "favorite" | "list";

/** One line of the comparison, as the page shows it. */
export type MirrorItem = {
  id: string;
  direction: MirrorDirection;
  kind: MirrorKind;
  mediaType: MediaKind;
  tmdbId: number | null;
  title: string;
  /** What will happen, in plain words. For "differ": what is being compared. */
  detail: string;
  here?: string;
  there?: string;
  /** Watch dates that differ: each side's (the page formats them). */
  hereDates?: (string | null)[];
  thereDates?: (string | null)[];
  /** A watched movie: its latest watch. */
  when?: string | null;
  /** Repeat watches of a movie: their dates. */
  dates?: (string | null)[];
  /**
   * Sent to WeTrakr by an earlier Apply, yet still missing there: when, and what WeTrakr answered
   * ("notFound": it said it does not know the title or episode; "refused"; "sent": it took it).
   */
  sentBefore?: { at: string; outcome: SentOutcome };
};

export type SentOutcome = "sent" | "notFound" | "refused";

/** A movie, or one episode of a show (s, e), whose plays are sent or brought in. */
type PlayTarget = { mediaType: MediaKind; tmdb: number; s?: number; e?: number; title: string; release: string | null };
/** Plays to add here for one title, and plays here to take away (a difference settled WeTrakr's way). */
type BringTitle = PlayTarget & { add: (string | null)[]; remove: LocalPlay[] };
type EpRating = { s: number; e: number; rating: number };

/** What applying an entry does. Kept on the server; the page only sees MirrorItem. */
type Action =
  | { do: "sendPlays"; plays: (PlayTarget & { at: string | null })[] }
  | { do: "replaceRemotePlays"; add: (PlayTarget & { at: string | null })[]; remove: (PlayTarget & { at: string })[] }
  | {
      do: "sendTracking"; mediaType: MediaKind; tmdb: number; status: "planning" | "dropped" | "paused" | "watching";
      /** A movie paused part-way on WeTrakr: cancel that playback first (it returns to its earlier state). */
      clearPlayback?: boolean;
    }
  | { do: "sendRating"; mediaType: MediaKind; tmdb: number; rating: number }
  | { do: "sendEpRatings"; tmdb: number; ratings: EpRating[] }
  | { do: "sendFavorite"; mediaType: MediaKind; tmdb: number }
  | { do: "sendList"; name: string; description: string | null; remoteId: string | null; items: { mediaType: MediaKind; tmdb: number }[] }
  | { do: "bringRows"; rows: ImportLibraryRow[] }
  | { do: "bringPlays"; show?: ImportLibraryRow; titles: BringTitle[] }
  | { do: "bringRating"; mediaType: MediaKind; tmdb: number; rating: number }
  | { do: "bringEpRatings"; tmdb: number; ratings: EpRating[] }
  | { do: "bringFlag"; mediaType: MediaKind; tmdb: number; flag: "watchlist" | "favorite" }
  | { do: "bringList"; name: string; description: string | null; items: { media_type: MediaKind; tmdb_id: number; title: string; release_date: string | null }[] };

export type MirrorEntry = MirrorItem & { send?: Action; bring?: Action };

const STATUS_WORD: Record<string, string> = {
  dropped: "Dropped", paused: "Paused", on_hold: "Paused", watching: "Watching", waiting: "Waiting",
  watched: "Watched", completed: "Watched", plan_to_watch: "Watchlist", active: "Watching",
};

/** Dropped / Paused / anything else, which is all the two sides can disagree on for a show. */
const localShowState = (s: LibraryStatus) => (s === "dropped" ? "dropped" : s === "on_hold" ? "paused" : "active");
const remoteShowState = (l: RemoteShowList | undefined) => (l === "dropped" ? "dropped" : l === "paused" ? "paused" : "active");
/** WeTrakr's list -> this app's status. Waiting is caught up on a show still airing: Watched here. */
const fromList = (l: RemoteShowList): LibraryStatus =>
  l === "dropped" ? "dropped" : l === "paused" ? "on_hold" : l === "watching" ? "watching" : "completed";

function seasonsText(eps: { s: number; e: number }[], plays: number): string {
  // A few episodes are named, so one that keeps coming back can be looked up.
  if (eps.length <= 3) {
    const names = [...eps].sort((a, b) => a.s - b.s || a.e - b.e).map((x) => `S${x.s} E${x.e}`).join(", ");
    return plays > eps.length ? `${names} (${plays} watches)` : names;
  }
  const seasons = [...new Set(eps.map((x) => x.s))].sort((a, b) => a - b);
  const span = seasons.length === 1 ? `season ${seasons[0]}` : `seasons ${seasons[0]}–${seasons[seasons.length - 1]}`;
  const extra = plays > eps.length ? `, ${plays} watches` : "";
  return `${eps.length} episode${eps.length === 1 ? "" : "s"} (${span}${extra})`;
}

export function compareMirror(local: LocalSnapshot, remote: RemoteSnapshot): MirrorEntry[] {
  const out: MirrorEntry[] = [];
  const lib = new Map(local.library.map((r) => [key(r.media_type, r.tmdb_id), r]));
  const showName = (id: number) => lib.get(key("tv", id))?.title ?? remote.shows.get(id)?.title ?? remote.showTitles.get(id) ?? `Show ${id}`;

  // Watches, play by play (rewatches included). A title watched on one side only is "missing" on the
  // other; plays only one side has are repeat watches; plays that do not line up on either side are
  // a difference in dates, where the user picks a side.
  for (const id of new Set([...local.moviePlays.keys(), ...remote.moviePlays.keys()])) {
    const L = local.moviePlays.get(id) ?? [];
    const R = remote.moviePlays.get(id) ?? [];
    const here = lib.get(key("movie", id));
    const title = here?.title ?? remote.watchedMovies.get(id)?.title ?? `Movie ${id}`;
    const base = { mediaType: "movie" as const, tmdbId: id, title };
    const target: PlayTarget = { mediaType: "movie", tmdb: id, title, release: here?.release_date ?? remote.watchedMovies.get(id)?.release ?? null };
    if (L.length && !R.length) {
      out.push({
        ...base, id: `send:movie:${id}`, direction: "send", kind: "movie", detail: timesText("Watched", L.length), when: latest(L.map((p) => p.at)),
        send: { do: "sendPlays", plays: L.map((p) => ({ ...target, at: p.at })) },
      });
    } else if (R.length && !L.length) {
      out.push({
        ...base, id: `bring:movie:${id}`, direction: "bring", kind: "movie", detail: timesText("Watched", R.length), when: latest(R),
        bring: { do: "bringPlays", titles: [{ ...target, add: R, remove: [] }] },
      });
    } else {
      const { ul, ur } = matchPlays(L, R);
      if (ul.length && !ur.length) {
        out.push({
          ...base, id: `send:rewatch:movie:${id}`, direction: "send", kind: "rewatch", detail: moreText(ul.length), dates: ul.map((p) => p.at),
          send: { do: "sendPlays", plays: ul.map((p) => ({ ...target, at: p.at })) },
        });
      } else if (ur.length && !ul.length) {
        out.push({
          ...base, id: `bring:rewatch:movie:${id}`, direction: "bring", kind: "rewatch", detail: moreText(ur.length), dates: ur,
          bring: { do: "bringPlays", titles: [{ ...target, add: ur, remove: [] }] },
        });
      } else if (ul.length && ur.length) {
        out.push({
          ...base, id: `differ:dates:movie:${id}`, direction: "differ", kind: "dates", detail: "Watch dates",
          hereDates: ul.map((p) => p.at), thereDates: ur,
          send: { do: "replaceRemotePlays", add: ul.map((p) => ({ ...target, at: p.at })), remove: ur.filter((at): at is string => !!at).map((at) => ({ ...target, at })) },
          bring: { do: "bringPlays", titles: [{ ...target, add: ur, remove: ul }] },
        });
      }
    }
  }

  // Episodes, gathered per show: one line per show for each kind of difference.
  const showIds = new Set([...local.episodePlays.keys(), ...remote.episodePlays.keys()].map((k) => Number(k.split(":")[0])));
  const epKeysOf = (m: Map<string, unknown>, id: number) => [...m.keys()].filter((k) => k.startsWith(`${id}:`));
  for (const id of showIds) {
    const title = showName(id);
    const base = { mediaType: "tv" as const, tmdbId: id, title };
    const list = remote.shows.get(id)?.list;
    const showRow: ImportLibraryRow = {
      media_type: "tv", tmdb_id: id, title, release_date: lib.get(key("tv", id))?.release_date ?? remote.shows.get(id)?.release ?? null,
      status: list ? fromList(list) : "watching",
    };
    const sendMissing: (PlayTarget & { at: string | null })[] = [];
    const bringMissing: BringTitle[] = [];
    const sendMore: (PlayTarget & { at: string | null })[] = [];
    const bringMore: BringTitle[] = [];
    const diffSend: (PlayTarget & { at: string | null })[] = [];
    const diffRemove: (PlayTarget & { at: string })[] = [];
    const diffBring: BringTitle[] = [];
    const counts = { sendMissing: new Set<string>(), bringMissing: new Set<string>(), sendMore: new Set<string>(), bringMore: new Set<string>(), differ: [] as string[] };
    let firstDiffer: { label: string; here: (string | null)[]; there: (string | null)[] } | null = null;
    for (const k of new Set([...epKeysOf(local.episodePlays, id), ...epKeysOf(remote.episodePlays, id)])) {
      const [, s, e] = k.split(":").map(Number);
      const target: PlayTarget = { mediaType: "tv", tmdb: id, s, e, title, release: null };
      const L = local.episodePlays.get(k) ?? [];
      const R = remote.episodePlays.get(k) ?? [];
      if (L.length && !R.length) {
        sendMissing.push(...L.map((p) => ({ ...target, at: p.at })));
        counts.sendMissing.add(k);
      } else if (R.length && !L.length) {
        if (s === 0) continue; // specials are left out, as the WeTrakr import does
        bringMissing.push({ ...target, add: R, remove: [] });
        counts.bringMissing.add(k);
      } else {
        const { ul, ur } = matchPlays(L, R);
        if (ul.length && !ur.length) {
          sendMore.push(...ul.map((p) => ({ ...target, at: p.at })));
          counts.sendMore.add(k);
        } else if (ur.length && !ul.length) {
          bringMore.push({ ...target, add: ur, remove: [] });
          counts.bringMore.add(k);
        } else if (ul.length && ur.length) {
          diffSend.push(...ul.map((p) => ({ ...target, at: p.at })));
          diffRemove.push(...ur.filter((at): at is string => !!at).map((at) => ({ ...target, at })));
          diffBring.push({ ...target, add: ur, remove: ul });
          counts.differ.push(k);
          firstDiffer ??= { label: `S${s} E${e}`, here: ul.map((p) => p.at), there: ur };
        }
      }
    }
    const eps = (keys: Set<string>) => [...keys].map((k) => { const [, s, e] = k.split(":").map(Number); return { s, e }; });
    if (sendMissing.length) {
      out.push({
        ...base, id: `send:episodes:${id}`, direction: "send", kind: "episodes", detail: seasonsText(eps(counts.sendMissing), sendMissing.length),
        send: { do: "sendPlays", plays: sendMissing },
      });
    }
    if (bringMissing.length) {
      out.push({
        ...base, id: `bring:episodes:${id}`, direction: "bring", kind: "episodes",
        detail: seasonsText(eps(counts.bringMissing), bringMissing.reduce((n, t) => n + t.add.length, 0)),
        bring: { do: "bringPlays", show: showRow, titles: bringMissing },
      });
    }
    if (sendMore.length) {
      out.push({
        ...base, id: `send:rewatch:tv:${id}`, direction: "send", kind: "rewatch", detail: moreText(sendMore.length, counts.sendMore.size),
        send: { do: "sendPlays", plays: sendMore },
      });
    }
    if (bringMore.length) {
      const n = bringMore.reduce((m, t) => m + t.add.length, 0);
      out.push({
        ...base, id: `bring:rewatch:tv:${id}`, direction: "bring", kind: "rewatch", detail: moreText(n, counts.bringMore.size),
        bring: { do: "bringPlays", titles: bringMore },
      });
    }
    if (firstDiffer) {
      const more = counts.differ.length - 1;
      out.push({
        ...base, id: `differ:dates:tv:${id}`, direction: "differ", kind: "dates",
        detail: `Watch dates: ${firstDiffer.label}${more ? ` and ${more} more episode${more === 1 ? "" : "s"}` : ""}`,
        hereDates: firstDiffer.here, thereDates: firstDiffer.there,
        send: { do: "replaceRemotePlays", add: diffSend, remove: diffRemove },
        bring: { do: "bringPlays", titles: diffBring },
      });
    }
  }

  // Episode ratings, per show
  for (const id of new Set([...local.episodeRatings.keys(), ...remote.episodeRatings.keys()].map((k) => Number(k.split(":")[0])))) {
    const title = showName(id);
    const base = { mediaType: "tv" as const, tmdbId: id, title };
    const send: EpRating[] = [];
    const bring: EpRating[] = [];
    const differHere: EpRating[] = [];
    const differThere: EpRating[] = [];
    for (const k of new Set([...epKeysOf(local.episodeRatings, id), ...epKeysOf(remote.episodeRatings, id)])) {
      const [, s, e] = k.split(":").map(Number);
      const mine = local.episodeRatings.get(k);
      const theirs = remote.episodeRatings.get(k);
      if (mine != null && theirs == null) send.push({ s, e, rating: mine });
      else if (theirs != null && mine == null) {
        // Only on episodes watched here, or being brought in with this comparison (specials never are, so a
        // special's rating would have nowhere to go and come back every time).
        if (local.episodePlays.has(k) || (remote.episodePlays.has(k) && s !== 0)) bring.push({ s, e, rating: theirs });
      } else if (mine != null && theirs != null && mine !== theirs) {
        differHere.push({ s, e, rating: mine });
        differThere.push({ s, e, rating: theirs });
      }
    }
    const label = (r: EpRating[]) => (r.length === 1 ? `S${r[0].s} E${r[0].e}: ${r[0].rating}/10` : `${r.length} episodes`);
    if (send.length) {
      out.push({ ...base, id: `send:eprating:${id}`, direction: "send", kind: "eprating", detail: `Ratings on ${label(send)}`, send: { do: "sendEpRatings", tmdb: id, ratings: send } });
    }
    if (bring.length) {
      out.push({ ...base, id: `bring:eprating:${id}`, direction: "bring", kind: "eprating", detail: `Ratings on ${label(bring)}`, bring: { do: "bringEpRatings", tmdb: id, ratings: bring } });
    }
    if (differHere.length) {
      const one = differHere.length === 1;
      out.push({
        ...base, id: `differ:eprating:${id}`, direction: "differ", kind: "eprating",
        detail: one ? `Episode rating: S${differHere[0].s} E${differHere[0].e}` : `Episode ratings on ${differHere.length} episodes`,
        here: one ? `${differHere[0].rating}/10` : "Popcornhour's", there: one ? `${differThere[0].rating}/10` : "WeTrakr's",
        send: { do: "sendEpRatings", tmdb: id, ratings: differHere },
        bring: { do: "bringEpRatings", tmdb: id, ratings: differThere },
      });
    }
  }

  const localShowsWithEps = new Set([...local.episodePlays.keys()].map((k) => Number(k.split(":")[0])));
  const remoteShowsWithEps = new Set([...remote.episodePlays.keys()].map((k) => Number(k.split(":")[0])));

  // Shows: on a list on one side only, or Dropped / Paused on one side
  for (const r of local.library) {
    if (r.media_type !== "tv" || r.status === "plan_to_watch") continue;
    const there = remote.shows.get(r.tmdb_id);
    const mine = localShowState(r.status);
    if (!there) {
      // Episodes being sent put a watched show on WeTrakr by themselves; Dropped / Paused still need saying.
      if (mine === "active" && localShowsWithEps.has(r.tmdb_id)) continue;
      const status = mine === "active" ? "watching" : mine;
      out.push({
        id: `send:show:${r.tmdb_id}`, direction: "send", kind: "show", mediaType: "tv", tmdbId: r.tmdb_id, title: r.title,
        detail: `Add as ${STATUS_WORD[status]}`, send: { do: "sendTracking", mediaType: "tv", tmdb: r.tmdb_id, status },
      });
      continue;
    }
    const theirs = remoteShowState(there.list);
    if (mine === theirs) continue;
    out.push({
      id: `differ:status:${r.tmdb_id}`, direction: "differ", kind: "status", mediaType: "tv", tmdbId: r.tmdb_id, title: r.title,
      detail: "Show status", here: STATUS_WORD[r.status], there: STATUS_WORD[there.list],
      send: { do: "sendTracking", mediaType: "tv", tmdb: r.tmdb_id, status: mine === "active" ? "watching" : mine },
      bring: { do: "bringRows", rows: [{ media_type: "tv", tmdb_id: r.tmdb_id, title: r.title, release_date: r.release_date, status: fromList(there.list), exact_status: true }] },
    });
  }
  for (const [id, s] of remote.shows) {
    if (lib.has(key("tv", id)) || remoteShowsWithEps.has(id)) continue; // episodes bring the show with them
    out.push({
      id: `bring:show:${id}`, direction: "bring", kind: "show", mediaType: "tv", tmdbId: id, title: s.title,
      detail: `Add as ${STATUS_WORD[s.list]}`,
      bring: { do: "bringRows", rows: [{ media_type: "tv", tmdb_id: id, title: s.title, release_date: s.release, status: fromList(s.list), exact_status: true }] },
    });
  }

  // Watchlist. WeTrakr moves a title OFF its other lists when it is put on the watchlist, so a watched
  // movie or a show already on one of its lists is never sent there.
  for (const r of local.library) {
    const k = key(r.media_type, r.tmdb_id);
    const onList = r.watchlist === 1 || r.status === "plan_to_watch";
    if (!onList || remote.planning.has(k)) continue;
    if (r.media_type === "movie" && (r.status === "completed" || remote.watchedMovies.has(r.tmdb_id))) continue;
    if (r.media_type === "tv" && (remote.shows.has(r.tmdb_id) || remoteShowsWithEps.has(r.tmdb_id))) continue;
    // Paused part-way on WeTrakr: that has to be cleared first, or the movie stays paused there.
    const paused = r.media_type === "movie" ? remote.pausedMovies.get(r.tmdb_id) : undefined;
    out.push({
      id: `send:watchlist:${k}`, direction: "send", kind: "watchlist", mediaType: r.media_type, tmdbId: r.tmdb_id, title: r.title,
      detail: paused
        ? `Add to watchlist. WeTrakr has it paused part-way${paused.progress != null ? ` (${paused.progress}%)` : ""}; that is cleared first`
        : "Add to watchlist",
      send: { do: "sendTracking", mediaType: r.media_type, tmdb: r.tmdb_id, status: "planning", ...(paused ? { clearPlayback: true } : {}) },
    });
  }
  for (const [k, t] of remote.planning) {
    const [mediaType, idText] = k.split(":") as [MediaKind, string];
    const id = Number(idText);
    const here = lib.get(k);
    if (here && (here.watchlist === 1 || here.status === "plan_to_watch")) continue;
    if (here && (here.status === "completed" || mediaType === "tv")) continue; // watched here, or a show already tracked here
    out.push({
      id: `bring:watchlist:${k}`, direction: "bring", kind: "watchlist", mediaType, tmdbId: id, title: t.title, detail: "Add to watchlist",
      bring: here
        ? { do: "bringFlag", mediaType, tmdb: id, flag: "watchlist" }
        : { do: "bringRows", rows: [{ media_type: mediaType, tmdb_id: id, title: t.title, release_date: t.release, status: "plan_to_watch" }] },
    });
  }

  // Ratings (only on titles in the library here; WeTrakr's are rounded to whole numbers)
  for (const r of local.library) {
    const k = key(r.media_type, r.tmdb_id);
    const there = remote.ratings.get(k);
    if (r.rating == null) continue;
    if (!there) {
      out.push({
        id: `send:rating:${k}`, direction: "send", kind: "rating", mediaType: r.media_type, tmdbId: r.tmdb_id, title: r.title,
        detail: `Rating ${r.rating}/10`, send: { do: "sendRating", mediaType: r.media_type, tmdb: r.tmdb_id, rating: r.rating },
      });
    } else if (there.rating !== r.rating) {
      out.push({
        id: `differ:rating:${k}`, direction: "differ", kind: "rating", mediaType: r.media_type, tmdbId: r.tmdb_id, title: r.title,
        detail: "Rating", here: `${r.rating}/10`, there: `${there.rating}/10`,
        send: { do: "sendRating", mediaType: r.media_type, tmdb: r.tmdb_id, rating: r.rating },
        bring: { do: "bringRating", mediaType: r.media_type, tmdb: r.tmdb_id, rating: there.rating },
      });
    }
  }
  // A rating on a title that is not in the library here comes with the rest of that title (if anything brings it).
  const bringing = new Set(out.filter((e) => e.direction === "bring" && e.tmdbId != null).map((e) => key(e.mediaType, e.tmdbId!)));
  for (const [k, t] of remote.ratings) {
    const [mediaType, idText] = k.split(":") as [MediaKind, string];
    const here = lib.get(k);
    if (here?.rating != null) continue;
    if (!here && !bringing.has(k)) continue;
    out.push({
      id: `bring:rating:${k}`, direction: "bring", kind: "rating", mediaType, tmdbId: Number(idText), title: t.title,
      detail: `Rating ${t.rating}/10`, bring: { do: "bringRating", mediaType, tmdb: Number(idText), rating: t.rating },
    });
  }

  // Favourites
  if (remote.favorites) {
    for (const r of local.library) {
      const k = key(r.media_type, r.tmdb_id);
      if (r.favorite !== 1 || remote.favorites.has(k)) continue;
      out.push({
        id: `send:favorite:${k}`, direction: "send", kind: "favorite", mediaType: r.media_type, tmdbId: r.tmdb_id, title: r.title,
        detail: "Add to favourites", send: { do: "sendFavorite", mediaType: r.media_type, tmdb: r.tmdb_id },
      });
    }
    for (const [k, t] of remote.favorites) {
      const [mediaType, idText] = k.split(":") as [MediaKind, string];
      const here = lib.get(k);
      if (here?.favorite === 1) continue;
      if (!here && !bringing.has(k)) continue;
      out.push({
        id: `bring:favorite:${k}`, direction: "bring", kind: "favorite", mediaType, tmdbId: Number(idText), title: t.title,
        detail: "Add to favourites", bring: { do: "bringFlag", mediaType, tmdb: Number(idText), flag: "favorite" },
      });
    }
  }

  // Lists, matched by name (as Import and Sync do)
  const remoteLists = new Map(remote.lists.map((l) => [l.name, l]));
  const localLists = new Map(local.lists.map((l) => [l.name, l]));
  const names = (n: number) => `${n} title${n === 1 ? "" : "s"}`;
  for (const l of local.lists) {
    const there = remoteLists.get(l.name);
    const missing = l.items.filter((it) => !there?.items.has(key(it.media_type, it.tmdb_id)));
    if (there && !missing.length) continue;
    out.push({
      id: `send:list:${l.name}`, direction: "send", kind: "list", mediaType: "movie", tmdbId: null, title: l.name,
      detail: there ? `Add ${names(missing.length)} to this list` : `Create this list with ${names(missing.length)}`,
      send: { do: "sendList", name: l.name, description: l.description, remoteId: there?.id ?? null, items: missing.map((it) => ({ mediaType: it.media_type, tmdb: it.tmdb_id })) },
    });
  }
  for (const l of remote.lists) {
    const here = localLists.get(l.name);
    const have = new Set(here?.items.map((it) => key(it.media_type, it.tmdb_id)));
    const missing = [...l.items.values()].filter((it) => !have.has(key(it.mediaType, it.tmdbId)));
    if (here && !missing.length) continue;
    out.push({
      id: `bring:list:${l.name}`, direction: "bring", kind: "list", mediaType: "movie", tmdbId: null, title: l.name,
      detail: here ? `Add ${names(missing.length)} to this list` : `Create this list with ${names(missing.length)}`,
      bring: {
        do: "bringList", name: l.name, description: l.description,
        items: missing.map((it) => ({ media_type: it.mediaType, tmdb_id: it.tmdbId, title: it.title, release_date: it.release })),
      },
    });
  }
  return out;
}

export function toPublic(e: MirrorEntry): MirrorItem {
  const { send: _s, bring: _b, ...item } = e;
  return item;
}

/** Read both sides and compare. Only reads. */
export async function buildMirror(
  userId: string,
  remote: Remote,
  onProgress?: (p: ReadProgress) => void,
): Promise<{ entries: MirrorEntry[]; notes: string[] }> {
  const notes: string[] = [];
  const snap = await readRemote(remote, notes, onProgress);
  const entries = markSentBefore(compareMirror(readLocal(userId), snap));
  logInfo(`[mirror] compared: ${entries.filter((e) => e.direction === "send").length} to send, ` +
    `${entries.filter((e) => e.direction === "bring").length} to bring in, ${entries.filter((e) => e.direction === "differ").length} different`);
  return { entries, notes };
}

// ---------- applying it ----------

export type MirrorChoice = { id: string; side: "send" | "bring" };

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** Split items into rounds so no title appears twice in one round (its second play goes in the next). */
function rounds<T>(items: T[], keyOf: (t: T) => string): T[][] {
  const out: T[][] = [];
  const seen = new Map<string, number>();
  for (const it of items) {
    const k = keyOf(it);
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    (out[n] ??= []).push(it);
  }
  return out;
}

const group = (m: MediaKind) => (m === "movie" ? "movies" : "shows");
/** A play's date as WeTrakr takes it; an unknown date says so rather than defaulting to now. */
const stamp = (at: string | null) => (at ? { tracked_at: at } : { tracked_at_unknown: true });

/** True when an answer's "not found" / "errored" part lists anything. */
function hasEntries(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "number") return v > 0;
  if (v && typeof v === "object") return Object.values(v).some(hasEntries);
  return false;
}

/** One request, and the keys (see unitKeys) of what it carries, so its answer can be remembered per item. */
type Req = { path: string; body: Record<string, unknown>; keys: string[]; method?: "DELETE" };
type Play = PlayTarget & { at: string | null };

const playKey = (p: Play) => `play:${p.mediaType}:${p.tmdb}:${p.s ?? ""}:${p.e ?? ""}:${minuteOf(p.at) ?? "unknown"}`;
const epRatingKey = (tmdb: number, r: EpRating) => `eprating:${tmdb}:${r.s}:${r.e}:${r.rating}`;
const listItemKey = (name: string, it: { mediaType: MediaKind; tmdb: number }) => `list:${name}:${it.mediaType}:${it.tmdb}`;

/** The separate things a "send" action carries, each with a key that stays the same from one comparison to the next. */
function unitKeys(a: Action): string[] {
  switch (a.do) {
    case "sendPlays": return a.plays.map(playKey);
    case "sendTracking": return [`tracking:${a.mediaType}:${a.tmdb}:${a.status}${a.clearPlayback ? ":clear" : ""}`];
    case "sendRating": return [`rating:${a.mediaType}:${a.tmdb}:${a.rating}`];
    case "sendFavorite": return [`favorite:${a.mediaType}:${a.tmdb}`];
    case "sendEpRatings": return a.ratings.map((r) => epRatingKey(a.tmdb, r));
    case "sendList": return a.items.map((it) => listItemKey(a.name, it));
    default: return [];
  }
}

// ---------- what was sent before ----------
// Everything an Apply sends is remembered with WeTrakr's answer. When the same thing still shows as
// missing in a later comparison, WeTrakr did not keep it (usually a title or episode it does not
// have, or numbers differently), so the screen lists it apart instead of offering it again as new.
// Keys that no longer show as missing are dropped, so this stays small.

type SentLog = Record<string, { at: string; outcome: SentOutcome }>;
const SENT_KEY = "mirror.sent.wetrakr";

function readSentLog(): SentLog {
  try {
    const v = JSON.parse(readSetting(SENT_KEY) ?? "{}");
    return v && typeof v === "object" ? (v as SentLog) : {};
  } catch {
    return {};
  }
}

function writeSentLog(log: SentLog): void {
  writeSetting(SENT_KEY, JSON.stringify(log));
}

/** Pick out the parts of an action whose keys are in `keep`. Only actions with several parts can be split. */
function subsetAction(a: Action, keep: Set<string>): Action {
  if (a.do === "sendPlays") return { ...a, plays: a.plays.filter((p) => keep.has(playKey(p))) };
  if (a.do === "sendEpRatings") return { ...a, ratings: a.ratings.filter((r) => keep.has(epRatingKey(a.tmdb, r))) };
  if (a.do === "sendList") return { ...a, items: a.items.filter((it) => keep.has(listItemKey(a.name, it))) };
  return a;
}

/** The line's wording for (part of) a "send" action, after it was split. */
function sendDetail(e: MirrorEntry, a: Action): string {
  if (a.do === "sendPlays") {
    const eps = [...new Map(a.plays.filter((p) => p.s != null).map((p) => [`${p.s}:${p.e}`, { s: p.s!, e: p.e! }])).values()];
    if (e.mediaType === "tv") return e.kind === "rewatch" ? moreText(a.plays.length, eps.length) : seasonsText(eps, a.plays.length);
    return e.kind === "rewatch" ? moreText(a.plays.length) : timesText("Watched", a.plays.length);
  }
  if (a.do === "sendEpRatings") {
    const r = a.ratings;
    return `Ratings on ${r.length === 1 ? `S${r[0].s} E${r[0].e}: ${r[0].rating}/10` : `${r.length} episodes`}`;
  }
  if (a.do === "sendList") return `Add ${a.items.length} title${a.items.length === 1 ? "" : "s"} to this list`;
  return e.detail;
}

/**
 * Mark "send" lines (or the parts of them) that an earlier Apply already sent, and forget sent keys
 * that are no longer missing on WeTrakr.
 */
function markSentBefore(entries: MirrorEntry[]): MirrorEntry[] {
  const log = readSentLog();
  const out: MirrorEntry[] = [];
  const stillMissing = new Set<string>();
  for (const e of entries) {
    const a = e.direction === "send" ? e.send : undefined;
    const keys = a ? unitKeys(a) : [];
    keys.forEach((k) => stillMissing.add(k));
    const before = keys.filter((k) => log[k]);
    if (!a || !before.length) {
      out.push(e);
      continue;
    }
    const outcomes = before.map((k) => log[k]);
    const sentBefore = {
      at: outcomes.map((o) => o.at).sort().at(-1)!,
      outcome: outcomes.some((o) => o.outcome === "notFound") ? "notFound" as const
        : outcomes.some((o) => o.outcome === "refused") ? "refused" as const : "sent" as const,
    };
    if (before.length === keys.length) {
      out.push({ ...e, sentBefore });
      continue;
    }
    // Some of it is new, some was sent before: two lines.
    const fresh = subsetAction(a, new Set(keys.filter((k) => !log[k])));
    const again = subsetAction(a, new Set(before));
    out.push({ ...e, send: fresh, detail: sendDetail(e, fresh) });
    out.push({ ...e, id: `${e.id}:again`, send: again, detail: sendDetail(e, again), sentBefore });
  }
  let changed = false;
  for (const k of Object.keys(log)) {
    if (!stillMissing.has(k)) {
      delete log[k];
      changed = true;
    }
  }
  if (changed) writeSentLog(log);
  return out;
}

/** Requests that add (or, on the remove path, take away) plays: movies 50 a request, episodes 100 per show. */
function playRequests(plays: Play[], path: "/sync/tracking" | "/sync/tracking/remove"): Req[] {
  const reqs: Req[] = [];
  const movies = plays.filter((p) => p.mediaType === "movie");
  for (const round of rounds(movies, (p) => `${p.tmdb}`)) {
    for (const part of chunk(round, 50)) {
      reqs.push({ path, body: { movies: part.map((p) => ({ ids: { tmdb: p.tmdb }, status: "watched", ...stamp(p.at) })) }, keys: part.map(playKey) });
    }
  }
  const shows = new Map<number, Play[]>();
  for (const p of plays) if (p.mediaType === "tv" && p.s != null && p.e != null) push(shows, p.tmdb, p);
  for (const [tmdb, eps] of shows) {
    for (const round of rounds(eps, (p) => `${p.s}:${p.e}`)) {
      for (const part of chunk(round.sort((a, b) => a.s! - b.s! || a.e! - b.e!), 100)) {
        // Always named episodes, never "the whole show".
        const seasons = [...new Set(part.map((x) => x.s!))].map((s) => ({
          number: s,
          episodes: part.filter((x) => x.s === s).map((x) => ({ number: x.e, status: "watched", ...stamp(x.at) })),
        }));
        reqs.push({ path, body: { shows: [{ ids: { tmdb }, seasons }] }, keys: part.map(playKey) });
      }
    }
  }
  return reqs;
}

/** The requests for the chosen "send" actions, batched so a big library is a few dozen requests, not thousands. */
function sendRequests(actions: Action[]): { reqs: Req[]; lists: Extract<Action, { do: "sendList" }>[] } {
  const adds: Play[] = [];
  const removes: Play[] = [];
  for (const a of actions) {
    if (a.do === "sendPlays") adds.push(...a.plays);
    else if (a.do === "replaceRemotePlays") {
      adds.push(...a.add);
      removes.push(...a.remove);
    }
  }
  // New plays first, then the ones they replace, so a title is never left with no watch in between.
  const reqs: Req[] = [...playRequests(adds, "/sync/tracking"), ...playRequests(removes, "/sync/tracking/remove")];
  const tracking = actions.filter((a): a is Extract<Action, { do: "sendTracking" }> => a.do === "sendTracking");
  // A movie paused part-way: cancel that playback first, then the watchlist add below can take hold.
  for (const a of tracking) {
    if (a.clearPlayback && a.mediaType === "movie") {
      reqs.push({ method: "DELETE", path: "/scrobble/playing", body: { movie: { ids: { tmdb: a.tmdb } } }, keys: [] });
    }
  }
  for (const status of ["planning", "dropped", "paused", "watching"] as const) {
    for (const m of ["movie", "tv"] as const) {
      const these = tracking.filter((a) => a.status === status && a.mediaType === m);
      for (const part of chunk(these, 50)) {
        reqs.push({ path: "/sync/tracking", body: { [group(m)]: part.map((a) => ({ ids: { tmdb: a.tmdb }, status })) }, keys: part.flatMap(unitKeys) });
      }
    }
  }
  for (const m of ["movie", "tv"] as const) {
    const ratings = actions.filter((a): a is Extract<Action, { do: "sendRating" }> => a.do === "sendRating" && a.mediaType === m);
    for (const part of chunk(ratings, 50)) {
      reqs.push({ path: "/sync/ratings", body: { [group(m)]: part.map((a) => ({ ids: { tmdb: a.tmdb }, rating: a.rating })) }, keys: part.flatMap(unitKeys) });
    }
    const favs = actions.filter((a): a is Extract<Action, { do: "sendFavorite" }> => a.do === "sendFavorite" && a.mediaType === m);
    for (const part of chunk(favs, 50)) {
      reqs.push({ path: "/sync/favorites", body: { [group(m)]: part.map((a) => ({ ids: { tmdb: a.tmdb } })) }, keys: part.flatMap(unitKeys) });
    }
  }
  for (const a of actions) {
    if (a.do !== "sendEpRatings") continue;
    for (const part of chunk(a.ratings, 100)) {
      const seasons = [...new Set(part.map((x) => x.s))].map((s) => ({
        number: s,
        episodes: part.filter((x) => x.s === s).map((x) => ({ number: x.e, rating: x.rating })),
      }));
      reqs.push({ path: "/sync/ratings", body: { shows: [{ ids: { tmdb: a.tmdb }, seasons }] }, keys: part.map((r) => epRatingKey(a.tmdb, r)) });
    }
  }
  return { reqs, lists: actions.filter((a): a is Extract<Action, { do: "sendList" }> => a.do === "sendList") };
}

/**
 * Bring one title's plays in. A title new here gets the latest date on its row (and a play row for
 * each watch when there is more than one); a title already watched here keeps its earlier watch as a
 * play row, loses the plays a difference was settled against, gets the new ones, and its date moves
 * to its latest play. Undated watches can only be brought in on a title that is new here.
 */
function bringTitle(userId: string, t: BringTitle): void {
  const db = getDb();
  const f: PlayFilter = { mediaType: t.mediaType, tmdbId: t.tmdb, seasonNumber: t.s ?? null, episodeNumber: t.e ?? null };
  const isMovie = t.mediaType === "movie";
  const titleRow = isMovie
    ? (db.prepare(`SELECT status, watched_at, rating FROM library_items WHERE user_id = ? AND media_type = 'movie' AND tmdb_id = ?`)
        .get(userId, t.tmdb) as { status: LibraryStatus; watched_at: string | null; rating: number | null } | undefined)
    : (db.prepare(`SELECT watched_at, rating FROM episode_progress WHERE user_id = ? AND tv_tmdb_id = ? AND season_number = ? AND episode_number = ?`)
        .get(userId, t.tmdb, t.s, t.e) as { watched_at: string | null; rating: number | null } | undefined);
  const watchedHere = isMovie ? (titleRow as { status?: LibraryStatus } | undefined)?.status === "completed" : !!titleRow;
  const dated = t.add.filter((at): at is string => !!at);
  const newest = latest(t.add);

  if (!watchedHere) {
    if (isMovie) {
      importLibraryRows(userId, [{ media_type: "movie", tmdb_id: t.tmdb, title: t.title, release_date: t.release, status: "completed", watched_at: newest }]);
    } else {
      importEpisodeProgress(userId, [{ tv_tmdb_id: t.tmdb, season_number: t.s!, episode_number: t.e!, watched_at: newest ?? nowIso() }]);
    }
    if (dated.length > 1) for (const at of dated) addPlay(userId, { ...f, watchedAt: at });
    return;
  }

  const rows = listPlays(userId, f);
  const dropStandIn = t.remove.some((p) => !p.id);
  if (!rows.length && titleRow?.watched_at && !dropStandIn && dated.length) {
    addPlay(userId, { ...f, watchedAt: titleRow.watched_at, rating: titleRow.rating }); // keep the earlier watch
  }
  for (const p of t.remove) if (p.id) removePlay(userId, p.id);
  const left = listPlays(userId, f);
  if (!left.length && dated.length === 1) {
    setTitleDate(userId, t, dated[0]); // one watch, kept as the title's date as Import does
    return;
  }
  for (const at of dated) addPlay(userId, { ...f, watchedAt: at });
  const all = listPlays(userId, f).map((p) => p.watched_at);
  const last = latest(all);
  if (last) setTitleDate(userId, t, last);
}

function setTitleDate(userId: string, t: PlayTarget, at: string): void {
  if (t.mediaType === "movie") {
    getDb().prepare(`UPDATE library_items SET watched_at = ? WHERE user_id = ? AND media_type = 'movie' AND tmdb_id = ?`).run(at, userId, t.tmdb);
  } else {
    getDb()
      .prepare(`UPDATE episode_progress SET watched_at = ? WHERE user_id = ? AND tv_tmdb_id = ? AND season_number = ? AND episode_number = ?`)
      .run(at, userId, t.tmdb, t.s, t.e);
  }
}

/** The chosen "bring" actions, all in one transaction. Nothing here is queued for Sync. */
function applyBring(userId: string, actions: Action[]): number {
  let n = 0;
  transaction(() => {
    const db = getDb();
    // Titles first, so ratings and flags find their row.
    for (const a of actions) {
      if (a.do === "bringRows") importLibraryRows(userId, a.rows);
      else if (a.do === "bringPlays") {
        if (a.show) importLibraryRows(userId, [a.show]);
        for (const t of a.titles) bringTitle(userId, t);
      } else continue;
      n++;
    }
    for (const a of actions) {
      if (a.do === "bringRating") setLibraryRating(userId, a.mediaType, a.tmdb, a.rating);
      else if (a.do === "bringEpRatings") {
        const set = db.prepare(
          `UPDATE episode_progress SET rating = ? WHERE user_id = ? AND tv_tmdb_id = ? AND season_number = ? AND episode_number = ?`,
        );
        for (const r of a.ratings) set.run(r.rating, userId, a.tmdb, r.s, r.e);
      } else if (a.do === "bringFlag") {
        db.prepare(`UPDATE library_items SET ${a.flag === "watchlist" ? "watchlist" : "favorite"} = 1, updated_at = ?
                     WHERE user_id = ? AND media_type = ? AND tmdb_id = ?`).run(nowIso(), userId, a.mediaType, a.tmdb);
      } else if (a.do === "bringList") {
        const listId = findListIdByName(userId, a.name) ?? createList(userId, a.name, a.description).id;
        importListItems(userId, listId, a.items);
      } else continue;
      n++;
    }
  });
  return n;
}

/**
 * Apply the ticked entries. The comparison is made again first, so only entries that still differ
 * are acted on. Things are brought in here first (one transaction), then sent to WeTrakr.
 */
export async function* runMirror(
  userId: string,
  remote: Remote,
  choices: MirrorChoice[],
  /** Hears how far the fresh read of WeTrakr has got. */
  onRead?: (p: ReadProgress) => void,
): AsyncGenerator<ProgressEvent> {
  const summary = { broughtIn: 0, sent: 0, notFound: 0, refused: 0 };
  try {
    yield { type: "phase", phase: "checking", total: 0 };
    const { entries } = await buildMirror(userId, remote, onRead);
    const byId = new Map(entries.map((e) => [e.id, e]));
    const send: Action[] = [];
    const bring: Action[] = [];
    for (const c of choices) {
      const e = byId.get(c.id);
      const action = e?.[c.side];
      if (action) (c.side === "send" ? send : bring).push(action);
    }

    if (bring.length) {
      yield { type: "phase", phase: "bringing in", total: bring.length };
      summary.broughtIn = applyBring(userId, bring);
      yield { type: "progress", phase: "bringing in", current: bring.length, total: bring.length };
    }

    const { reqs, lists } = sendRequests(send);
    const total = reqs.length + lists.length;
    if (total) yield { type: "phase", phase: "sending", total };
    const run = newId();
    let n = 0;
    let done = 0;
    // What was sent, and WeTrakr's answer, is remembered so a later comparison can tell when it did not stick.
    const log = readSentLog();
    const post = async (path: string, body: Record<string, unknown>, keys: string[]) => {
      assertNoWholeShow({ path, body });
      const res = await remote.post<Record<string, unknown>>(path, body, `mirror:${run}:${n++}`);
      logInfo(`[mirror] POST ${path} -> ${redactText(JSON.stringify(res ?? null).slice(0, 300))}`);
      const notFound = hasEntries(res?.not_found) || hasEntries(res?.notFound);
      const refused = hasEntries(res?.errored);
      if (notFound) summary.notFound++;
      if (refused) summary.refused++;
      // The answer covers the whole request: every key in it gets the same note.
      const outcome: SentOutcome = notFound ? "notFound" : refused ? "refused" : "sent";
      const at = new Date().toISOString();
      for (const k of keys) log[k] = { at, outcome };
      if (keys.length) writeSentLog(log);
      return res;
    };
    for (const r of reqs) {
      if (r.method === "DELETE") {
        // Nothing playing any more (404) is the wanted end state, so it is not a failure.
        try {
          const res = await remote.write("DELETE", r.path, r.body, `mirror:${run}:${n++}`);
          logInfo(`[mirror] DELETE ${r.path} -> ${redactText(JSON.stringify(res ?? null).slice(0, 200))}`);
        } catch (e) {
          if (!(e instanceof Error && / 404 /.test(e.message))) throw e;
        }
        done++;
        yield { type: "progress", phase: "sending", current: done, total };
        continue;
      }
      await post(r.path, r.body, r.keys);
      summary.sent++;
      done++;
      yield { type: "progress", phase: "sending", current: done, total };
    }
    for (const l of lists) {
      let id = l.remoteId;
      if (!id) {
        const made = await post("/sync/lists", { name: l.name, ...(l.description ? { description: l.description } : {}) }, []);
        id = made?.id != null ? String(made.id) : null;
        if (!id) throw new Error(`WeTrakr did not return the new list “${l.name}”`);
      }
      for (const m of ["movie", "tv"] as const) {
        const these = l.items.filter((it) => it.mediaType === m);
        for (const part of chunk(these, 50)) {
          const body = { [group(m)]: part.map((it) => ({ ids: { tmdb: it.tmdb } })) };
          await post(`/sync/lists/${id}/items`, body, part.map((it) => listItemKey(l.name, it)));
        }
      }
      summary.sent++;
      done++;
      yield { type: "progress", phase: "sending", current: done, total };
    }
    logInfo(`[mirror] finished: ${JSON.stringify(summary)}`);
    yield { type: "done", summary };
  } catch (e) {
    logError("Compare with WeTrakr: applying failed", e);
    yield {
      type: "error",
      message: `${redactText(e instanceof Error ? e.message : "Failed")}. ${summary.broughtIn} brought in and ${summary.sent} sent before it stopped. Compare again to see what is left.`,
    };
  }
}
