import { getDb, USER_ID } from "./db.ts";
import { readSetting, writeSetting } from "./backup.server.ts";
import { publicUrl } from "./config.server.ts";
import { toBadgeProviders } from "./providers.server.ts";
import { errorText, logError, logInfo } from "./redact.server.ts";

/**
 * Release notifications: once a day Popcornhour goes through the movies on your watchlist (not watched yet) and tells
 * you, through Home Assistant, when one of them
 *  - is on a subscription streaming service in the US for the first time ("streaming"),
 *  - has reached its US digital (rent / buy) release date ("digital"),
 *  - has reached its US cinema release date ("cinema").
 * Each of these is sent once per movie. The first time the check sees a movie (the first run, or a movie just put on
 * the watchlist) whatever is already true is only noted, not sent, so you are not told about things that happened
 * before. A movie that leaves the watchlist is forgotten, so putting it back starts afresh.
 *
 * The message goes to HA_WEBHOOK_URL (a Home Assistant webhook trigger) as JSON
 * { title, message, image, url, tag }; an automation there passes it on to the phone. Off while that is empty.
 */

export type NotifyEvent = "streaming" | "digital" | "cinema";

export type NotifyRunResult = {
  at: string;
  checked: number;
  sent: number;
  noted: number;
  failed: number;
  problem: string | null;
};

export type NotifyMessage = { title: string; message: string; image: string | null; url: string | null; tag: string };

const RUN_HOUR_SYDNEY = 9; // the daily check runs at (or soon after) 9am Canberra time
const TICK_MS = 15 * 60 * 1000;
const FIRST_TICK_MS = 2 * 60 * 1000;

export function webhookUrl(): string | null {
  const raw = process.env.HA_WEBHOOK_URL?.trim();
  return raw ? raw : null;
}

// ---------- dates ----------

const dayIn = (timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
const sydneyDay = dayIn("Australia/Sydney");
/** Release dates are US ones, so "has it come out" is asked on the US west-coast calendar. */
const usDay = dayIn("America/Los_Angeles");
const sydneyHour = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", hour: "numeric", hourCycle: "h23" });

// ---------- TMDB ----------

type RawProvider = { provider_id: number; provider_name: string; logo_path: string | null; display_priority?: number };
type TmdbMovie = {
  id: number;
  title: string;
  poster_path: string | null;
  backdrop_path: string | null;
  "watch/providers"?: { results?: Record<string, { flatrate?: RawProvider[] }> };
  release_dates?: { results?: { iso_3166_1: string; release_dates: { type: number; release_date: string }[] }[] };
};

async function fetchMovie(id: number): Promise<TmdbMovie | null> {
  const key = process.env.TMDB_API_KEY;
  if (!key) throw new Error("TMDB_API_KEY not configured");
  const url = `https://api.themoviedb.org/3/movie/${id}?api_key=${key}&language=en-US&append_to_response=watch/providers,release_dates`;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`TMDB ${res.status}`);
  return (await res.json()) as TmdbMovie;
}

/** What is true about a movie now: the US streaming services, and its US digital / cinema dates if they have come. */
function currentEvents(m: TmdbMovie, wts: Map<number, string> | null, today: string): Map<NotifyEvent, string> {
  const out = new Map<NotifyEvent, string>();
  const services = toBadgeProviders(m["watch/providers"]?.results?.["US"]?.flatrate).map((p) => p.name);
  if (services.length) out.set("streaming", services.join(", "));

  const us = m.release_dates?.results?.find((r) => r.iso_3166_1 === "US")?.release_dates ?? [];
  const earliest = (type: number) =>
    us
      .filter((r) => r.type === type && r.release_date)
      .map((r) => r.release_date.slice(0, 10))
      .sort()[0] ?? null;
  const digital = earliest(4) ?? wts?.get(m.id) ?? null; // whentostream when TMDB has no digital date (as elsewhere)
  const cinema = earliest(3) ?? earliest(2);
  if (digital && digital <= today) out.set("digital", digital);
  if (cinema && cinema <= today) out.set("cinema", cinema);
  return out;
}

function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

/** One notification for everything new about a movie in this run. */
export function buildMessage(m: Pick<TmdbMovie, "id" | "title" | "poster_path" | "backdrop_path">, events: Map<NotifyEvent, string>): NotifyMessage {
  const parts: string[] = [];
  const streaming = events.get("streaming");
  if (streaming) parts.push(`Now streaming on ${listNames(streaming.split(", "))} in the US`);
  if (events.has("digital")) parts.push(parts.length ? "out to rent or buy" : "Out to rent or buy in the US");
  // Already at home, so "in cinemas" would only be news from before.
  if (events.has("cinema") && !parts.length) parts.push("In US cinemas now");
  const art = m.backdrop_path ?? m.poster_path;
  const base = publicUrl();
  return {
    title: m.title,
    message: parts.join(" and ") + ".",
    image: art ? `https://image.tmdb.org/t/p/w780${art}` : null,
    url: base ? `${base}/movie/${m.id}` : null,
    tag: `popcornhour-movie-${m.id}`,
  };
}

// ---------- sending ----------

export async function sendToHomeAssistant(msg: NotifyMessage): Promise<void> {
  const url = webhookUrl();
  if (!url) throw new Error("HA_WEBHOOK_URL is not set");
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(msg),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Home Assistant answered ${res.status}`);
}

export async function sendTestNotification(): Promise<void> {
  const base = publicUrl();
  await sendToHomeAssistant({
    title: "Popcornhour",
    message: "Test notification. Release notifications will look like this.",
    image: null,
    url: base ? `${base}/settings/notifications` : null,
    tag: "popcornhour-test",
  });
}

// ---------- the check ----------

function watchlistMovies(): number[] {
  return (
    getDb()
      .prepare(
        `SELECT tmdb_id FROM library_items
          WHERE user_id = ? AND media_type = 'movie' AND watchlist = 1 AND status <> 'completed'`,
      )
      .all(USER_ID) as { tmdb_id: number }[]
  ).map((r) => r.tmdb_id);
}

async function mapPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

let running: Promise<NotifyRunResult> | null = null;

/** Runs the check now (one at a time). Sends nothing, and changes nothing, while HA_WEBHOOK_URL is empty. */
export function runReleaseCheck(): Promise<NotifyRunResult> {
  if (!running) running = doRun().finally(() => (running = null));
  return running;
}

async function doRun(): Promise<NotifyRunResult> {
  const result: NotifyRunResult = { at: new Date().toISOString(), checked: 0, sent: 0, noted: 0, failed: 0, problem: null };
  if (!webhookUrl()) {
    result.problem = "HA_WEBHOOK_URL is not set";
    return result;
  }
  const db = getDb();
  const ids = watchlistMovies();
  const onList = new Set(ids);

  // Forget movies that have left the watchlist (or been watched).
  const seen = new Set((db.prepare("SELECT tmdb_id FROM release_notify_seen").all() as { tmdb_id: number }[]).map((r) => r.tmdb_id));
  const forget = db.transaction((gone: number[]) => {
    for (const id of gone) {
      db.prepare("DELETE FROM release_notify_seen WHERE tmdb_id = ?").run(id);
      db.prepare("DELETE FROM release_notify_events WHERE tmdb_id = ?").run(id);
    }
  });
  forget([...seen].filter((id) => !onList.has(id)));

  const { getWtsHomeDates } = await import("@/lib/tmdb.functions");
  const wts = await getWtsHomeDates(20_000).catch(() => null);
  const today = usDay.format(new Date());
  const known = db.prepare("SELECT event FROM release_notify_events WHERE tmdb_id = ?");
  const record = db.prepare(
    `INSERT INTO release_notify_events (tmdb_id, event, sent, detail) VALUES (?, ?, ?, ?)
     ON CONFLICT(tmdb_id, event) DO NOTHING`,
  );
  const markSeen = db.prepare("INSERT OR IGNORE INTO release_notify_seen (tmdb_id) VALUES (?)");

  let firstError: string | null = null;
  await mapPool(ids, 4, async (id) => {
    try {
      const m = await fetchMovie(id);
      if (!m) return;
      result.checked++;
      const now = currentEvents(m, wts, today);
      if (!seen.has(id)) {
        // First look at this movie: note what is already true, send nothing.
        db.transaction(() => {
          markSeen.run(id);
          for (const [ev, detail] of now) record.run(id, ev, 0, detail);
        })();
        result.noted += now.size;
        return;
      }
      const had = new Set((known.all(id) as { event: string }[]).map((r) => r.event));
      const fresh = new Map([...now].filter(([ev]) => !had.has(ev)));
      if (!fresh.size) return;
      await sendToHomeAssistant(buildMessage(m, fresh)); // throws: nothing recorded, so the next run tries again
      db.transaction(() => {
        for (const [ev, detail] of fresh) record.run(id, ev, 1, detail);
      })();
      result.sent++;
    } catch (e) {
      result.failed++;
      firstError ??= errorText(e);
      logError("[notify] release check failed for a movie", e, id);
    }
  });
  result.problem = firstError;
  writeSetting("notify.lastRun", JSON.stringify(result));
  logInfo(`[notify] checked ${result.checked}, sent ${result.sent}, noted ${result.noted}, failed ${result.failed}`);
  return result;
}

export function lastRun(): NotifyRunResult | null {
  const raw = readSetting("notify.lastRun");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as NotifyRunResult;
  } catch {
    return null;
  }
}

export function notifyState() {
  return {
    enabled: !!webhookUrl(),
    watchlistMovies: watchlistMovies().length,
    lastRun: lastRun(),
    runHour: RUN_HOUR_SYDNEY,
  };
}

// ---------- schedule ----------

/** Runs the check once a day, at the first tick after 9am Canberra time. */
async function tick(): Promise<void> {
  if (!webhookUrl()) return;
  const now = new Date();
  if (Number(sydneyHour.format(now)) < RUN_HOUR_SYDNEY) return;
  const day = sydneyDay.format(now);
  if (readSetting("notify.lastDay") === day) return;
  writeSetting("notify.lastDay", day); // first, so a failing run is not repeated every 15 minutes
  await runReleaseCheck();
}

const g = globalThis as { __popcornhourNotifyTimer?: boolean };

/** Starts the timer once per server process (called when the database is first opened). */
export function startReleaseNotifyScheduler(): void {
  if (g.__popcornhourNotifyTimer) return;
  g.__popcornhourNotifyTimer = true;
  const run = () => {
    tick().catch((e) => logError("[notify] daily release check failed", e));
  };
  setTimeout(run, FIRST_TICK_MS).unref();
  setInterval(run, TICK_MS).unref();
}
