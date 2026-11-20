/**
 * Refresh posters runs on the server as a job, not as one long request: a phone that goes to sleep
 * (or a closed page) no longer stops it. The page starts the job and then only asks how it is going;
 * opening the screen again picks up the running job, or its finished result.
 *
 * One job per user at a time, kept in memory: a server restart forgets it (posters already saved stay
 * saved, and running it again carries on with whatever is still missing).
 */
import { listItemsMissingPoster, updatePosters } from "./library.server.ts";
import { logError, redactText } from "./redact.server.ts";

const TMDB_BASE = "https://api.themoviedb.org/3";

export type PosterJob = {
  state: "running" | "done" | "error";
  startedAt: string;
  finishedAt: string | null;
  /** Titles looked up so far, of total. */
  current: number;
  total: number;
  /** Titles that got a poster. */
  updated: number;
  /** Titles TMDB had no poster for (or could not be reached for). */
  missed: number;
  problem?: string;
};

const jobs = new Map<string, PosterJob>();

export function getPosterJob(userId: string): PosterJob | null {
  return jobs.get(userId) ?? null;
}

/** Forget a finished job. A running one is left alone. */
export function clearPosterJob(userId: string): void {
  if (jobs.get(userId)?.state !== "running") jobs.delete(userId);
}

async function fetchPoster(
  key: string,
  mediaType: "movie" | "tv",
  tmdbId: number,
): Promise<{ poster_path: string | null; backdrop_path: string | null } | null> {
  const res = await fetch(`${TMDB_BASE}/${mediaType}/${tmdbId}?api_key=${key}&language=en-US`);
  if (!res.ok) return null;
  const j = (await res.json()) as { poster_path?: string | null; backdrop_path?: string | null };
  return { poster_path: j.poster_path ?? null, backdrop_path: j.backdrop_path ?? null };
}

/** Start looking up posters for everything missing one, unless a job is already running (that one is returned). */
export function startPosterJob(userId: string): PosterJob {
  const running = jobs.get(userId);
  if (running?.state === "running") return running;

  const key = process.env.TMDB_API_KEY;
  if (!key) throw new Error("TMDB_API_KEY not configured");

  const items = listItemsMissingPoster(userId);
  const job: PosterJob = {
    state: items.length ? "running" : "done",
    startedAt: new Date().toISOString(),
    finishedAt: items.length ? null : new Date().toISOString(),
    current: 0,
    total: items.length,
    updated: 0,
    missed: 0,
  };
  jobs.set(userId, job);
  if (!items.length) return job;

  void (async () => {
    try {
      let next = 0;
      const worker = async () => {
        while (next < items.length) {
          const it = items[next++];
          const found = await fetchPoster(key, it.media_type, it.tmdb_id).catch(() => null);
          if (found?.poster_path) {
            updatePosters(userId, it.media_type, it.tmdb_id, found.poster_path, found.backdrop_path);
            job.updated += 1;
          } else {
            job.missed += 1;
          }
          job.current += 1;
        }
      };
      await Promise.all(Array.from({ length: Math.min(6, items.length) }, worker));
      job.state = "done";
    } catch (e) {
      logError("Refresh posters failed", e);
      job.problem = redactText(e instanceof Error ? e.message : "Refresh posters failed");
      job.state = "error";
    }
    job.finishedAt = new Date().toISOString();
  })();
  return job;
}
