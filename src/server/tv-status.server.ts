import { getDb } from "./db.ts";
import { readSetting, writeSetting } from "./backup.server.ts";
import { getCachedEntry, setCachedMany } from "./tmdb-cache.server.ts";
import { errorText, logError, logInfo } from "./redact.server.ts";
import * as lib from "./library.server.ts";
import { trackedSetShowStatus } from "./sync-changes.server.ts";
import type { LibraryStatus } from "./types.ts";

/**
 * A show's Watching / Watched status, worked out from the episodes ticked and what has aired (TMDB).
 *
 *  - No episodes ticked: left as it is (a show on the Watchlist stays there).
 *  - Aired episodes still to watch: Watching.
 *  - Caught up, but the season that is airing has more episodes to come: Watching.
 *  - Caught up, and that season (or the show) has finished: Watched.
 *  - A Watched show whose next season starts airing (its first episode is out): back to Watching.
 * Paused and Dropped shows are never moved by this (a Paused show still comes back to Watching when a new season
 * starts, as before).
 *
 * It runs after every tick / untick (and a removed play) on a show, and once a day for every show, which also
 * catches shows imported from Trakt or WeTrakr and new episodes airing.
 *
 * A show already Watched only goes back to Watching when something is missing at the END (a newer episode than
 * the furthest one ticked) or the season is still airing: an episode missing in the middle of an old season (a
 * numbering difference with Trakt, say) does not move it. Specials (season 0) never count.
 */

export type TvAirState = {
  status: string | null; // TMDB: "Returning Series", "Ended", "Canceled", "In Production", ...
  seasons: { season_number: number; episode_count: number; air_date: string | null }[];
  last: { season_number: number; episode_number: number } | null; // the latest episode that has aired
  next: { season_number: number; episode_number: number } | null; // the next one to air, if TMDB knows it
};

type Tick = { season_number: number; episode_number: number };

const CACHE_TTL_MS = 60 * 60 * 1000; // ticks in a row reuse one lookup; the daily run always asks again
const RUN_HOUR_SYDNEY = 9;
const TICK_MS = 15 * 60 * 1000;
const FIRST_TICK_MS = 3 * 60 * 1000;

const ENDED = new Set(["Ended", "Canceled"]);

// ---------- the rule ----------

/** The latest aired episode in a regular season (TMDB's own one, unless that is a special). */
function lastRegular(s: TvAirState, today: string) {
  if (s.last && s.last.season_number > 0) return s.last;
  const aired = s.seasons
    .filter((x) => x.season_number > 0 && x.episode_count > 0 && x.air_date && x.air_date <= today)
    .sort((a, b) => b.season_number - a.season_number)[0];
  return aired ? { season_number: aired.season_number, episode_number: aired.episode_count } : null;
}

/** The status the show should have now, or null to leave it as it is. */
export function decideShowStatus(
  current: LibraryStatus,
  ticks: Tick[],
  s: TvAirState,
  today = new Date().toISOString().slice(0, 10),
): LibraryStatus | null {
  if (current !== "plan_to_watch" && current !== "watching" && current !== "completed") return null;
  const regular = ticks.filter((t) => t.season_number > 0 && t.episode_number > 0);
  if (!regular.length) return null;
  const last = lastRegular(s, today);
  if (!last) return null;

  const seasonCount = (n: number) => s.seasons.find((x) => x.season_number === n)?.episode_count ?? 0;
  const airedIn = (n: number) => (n > last.season_number ? 0 : n === last.season_number ? last.episode_number : seasonCount(n));

  let airedTotal = 0;
  for (let n = 1; n <= last.season_number; n++) airedTotal += airedIn(n);
  const watchedAired = regular.filter((t) => t.episode_number <= airedIn(t.season_number)).length;

  const furthest = regular.reduce((a, b) =>
    b.season_number > a.season_number || (b.season_number === a.season_number && b.episode_number > a.episode_number) ? b : a,
  );
  const behind =
    last.season_number > furthest.season_number ||
    (last.season_number === furthest.season_number && last.episode_number > furthest.episode_number);

  // More of the airing season to come: TMDB names the next episode in it, or the season lists more episodes than
  // have aired (dates not out yet). Never for a show that has ended.
  const moreThisSeason =
    !ENDED.has(s.status ?? "") &&
    ((s.next != null && s.next.season_number === last.season_number) || seasonCount(last.season_number) > last.episode_number);

  const target: LibraryStatus =
    current === "completed"
      ? behind || moreThisSeason ? "watching" : "completed"
      : !behind && !moreThisSeason && watchedAired >= airedTotal ? "completed" : "watching";
  return target === current ? null : target;
}

// ---------- TMDB ----------

async function fetchAirState(tmdbId: number, fresh: boolean): Promise<TvAirState | null> {
  const key = `airstate:tv:${tmdbId}`;
  if (!fresh) {
    const hit = getCachedEntry<TvAirState>(key);
    if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) return hit.value;
  }
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) throw new Error("TMDB_API_KEY not configured");
  const res = await fetch(`https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${apiKey}&language=en-US`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`TMDB ${res.status}`);
  const tv = (await res.json()) as {
    status?: string | null;
    seasons?: { season_number: number; episode_count: number; air_date: string | null }[];
    last_episode_to_air?: { season_number: number; episode_number: number } | null;
    next_episode_to_air?: { season_number: number; episode_number: number } | null;
  };
  const pick = (e: { season_number: number; episode_number: number } | null | undefined) =>
    e ? { season_number: e.season_number, episode_number: e.episode_number } : null;
  const state: TvAirState = {
    status: tv.status ?? null,
    seasons: (tv.seasons ?? []).map((x) => ({ season_number: x.season_number, episode_count: x.episode_count, air_date: x.air_date })),
    last: pick(tv.last_episode_to_air),
    next: pick(tv.next_episode_to_air),
  };
  setCachedMany([[key, state]]);
  return state;
}

function airedSeasons(s: TvAirState, today: string): number {
  return s.seasons.filter((x) => x.season_number > 0 && x.air_date && x.air_date <= today && x.episode_count > 0).length;
}

// ---------- applying it ----------

export type ShowMove = { tmdbId: number; title: string; from: LibraryStatus; to: LibraryStatus };

async function refresh(userId: string, tmdbId: number, fresh: boolean): Promise<ShowMove | null> {
  const item = lib.getLibraryItem(userId, "tv", tmdbId);
  if (!item) return null;
  const today = new Date().toISOString().slice(0, 10);
  const ticks = lib.listEpisodeProgress(userId, tmdbId);
  const canMove = item.status === "plan_to_watch" || item.status === "watching" || item.status === "completed";
  if (!(canMove && ticks.some((t) => t.season_number > 0)) && item.status !== "on_hold") return null;

  const state = await fetchAirState(tmdbId, fresh);
  if (!state) return null;
  const seasons = airedSeasons(state, today);

  let to = decideShowStatus(item.status, ticks, state, today);
  // Paused: back to Watching when a new season starts (only once a season count has been noted, so the first look
  // at a show does not count as "new").
  const prevSeasons = item.last_known_seasons ?? 0;
  if (item.status === "on_hold" && prevSeasons > 0 && seasons > prevSeasons) to = "watching";

  if (!to && seasons === prevSeasons) return null;
  trackedSetShowStatus(userId, tmdbId, { status: to ?? undefined, lastKnownSeasons: seasons });
  return to ? { tmdbId, title: item.title, from: item.status, to } : null;
}

/** After a tick / untick on a show: move it if it should be. Never throws (the tick itself has been saved). */
export async function refreshShowStatus(userId: string, tmdbId: number): Promise<void> {
  try {
    const moved = await refresh(userId, tmdbId, false);
    if (moved) logInfo(`[tv-status] ${moved.title}: ${moved.from} -> ${moved.to}`);
  } catch (e) {
    logError("[tv-status] could not work out the show's status", e, tmdbId);
  }
}

/** The show a play belongs to (to refresh it once the play is removed). */
export function showOfPlay(userId: string, playId: string): number | null {
  const p = getDb().prepare(`SELECT media_type, tmdb_id FROM plays WHERE id = ? AND user_id = ?`).get(playId, userId) as
    | { media_type: string; tmdb_id: number }
    | undefined;
  return p?.media_type === "tv" ? p.tmdb_id : null;
}

// ---------- the daily run ----------

export type ShowStatusRunResult = { at: string; checked: number; moved: ShowMove[]; failed: number; problem: string | null };

async function mapPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const worker = async () => {
    while (i < items.length) await fn(items[i++]);
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

let running: Promise<ShowStatusRunResult> | null = null;

/** Every show in the library, looked at again with fresh TMDB data (one run at a time). */
export function runShowStatusCheck(): Promise<ShowStatusRunResult> {
  if (!running) running = doRun().finally(() => (running = null));
  return running;
}

async function doRun(): Promise<ShowStatusRunResult> {
  const result: ShowStatusRunResult = { at: new Date().toISOString(), checked: 0, moved: [], failed: 0, problem: null };
  const shows = lib.listAllTvItems().filter((s) => s.status !== "dropped");
  await mapPool(shows, 4, async (s) => {
    try {
      const moved = await refresh(s.user_id, s.tmdb_id, true);
      result.checked++;
      if (moved) result.moved.push(moved);
    } catch (e) {
      result.failed++;
      result.problem ??= errorText(e);
      logError("[tv-status] daily check failed for a show", e, s.tmdb_id);
    }
  });
  writeSetting("tvStatus.lastRun", JSON.stringify(result));
  logInfo(
    `[tv-status] checked ${result.checked}, moved ${result.moved.length}, failed ${result.failed}` +
      result.moved.map((m) => `\n  ${m.title}: ${m.from} -> ${m.to}`).join(""),
  );
  return result;
}

export function lastShowStatusRun(): ShowStatusRunResult | null {
  try {
    const raw = readSetting("tvStatus.lastRun");
    return raw ? (JSON.parse(raw) as ShowStatusRunResult) : null;
  } catch {
    return null;
  }
}

// ---------- schedule ----------

const sydneyDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" });
const sydneyHour = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", hour: "numeric", hourCycle: "h23" });

async function tick(): Promise<void> {
  if (!process.env.TMDB_API_KEY) return;
  const now = new Date();
  if (Number(sydneyHour.format(now)) < RUN_HOUR_SYDNEY) return;
  const day = sydneyDay.format(now);
  if (readSetting("tvStatus.lastDay") === day) return;
  writeSetting("tvStatus.lastDay", day); // first, so a failing run is not repeated every 15 minutes
  await runShowStatusCheck();
}

const g = globalThis as { __popcornhourTvStatusTimer?: boolean };

/** Starts the daily timer once per server process (called when the database is first opened). */
export function startShowStatusScheduler(): void {
  if (g.__popcornhourTvStatusTimer) return;
  g.__popcornhourTvStatusTimer = true;
  const run = () => {
    tick().catch((e) => logError("[tv-status] daily show check failed", e));
  };
  setTimeout(run, FIRST_TICK_MS).unref();
  setInterval(run, TICK_MS).unref();
}
