import { createServerFn } from "@tanstack/react-start";
import { requireUser } from "@/lib/auth-middleware";
import { listItemsMissingPoster, updatePosters } from "@/server/library.server";

const TMDB_BASE = "https://api.themoviedb.org/3";

async function fetchPoster(mediaType: "movie" | "tv", tmdbId: number): Promise<{ poster_path: string | null; backdrop_path: string | null } | null> {
  const key = process.env.TMDB_API_KEY;
  if (!key) throw new Error("TMDB_API_KEY not configured");
  const url = `${TMDB_BASE}/${mediaType}/${tmdbId}?api_key=${key}&language=en-US`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const j = (await res.json()) as { poster_path: string | null; backdrop_path: string | null };
  return { poster_path: j.poster_path ?? null, backdrop_path: j.backdrop_path ?? null };
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

export const backfillPosters = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .handler(async ({ context }) => {
    const { userId } = context;

    // Distinct (media_type, tmdb_id) pairs missing a poster in library_items or list_items.
    const unique = listItemsMissingPoster(userId);
    const total = unique.length;
    if (total === 0) return { updated: 0, total: 0 };

    const fetched = await mapWithConcurrency(unique, 6, async (it) => ({
      ...it,
      ...(await fetchPoster(it.media_type, it.tmdb_id).catch(() => null)),
    }));

    let updated = 0;
    for (const f of fetched) {
      if (!f || !("poster_path" in f) || !f.poster_path) continue;
      updatePosters(userId, f.media_type, f.tmdb_id, f.poster_path, f.backdrop_path ?? null);
      updated += 1;
    }
    return { updated, total };
  });
