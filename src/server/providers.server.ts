import { getDb, nowIso } from "./db.ts";
import type { MediaKind } from "./types.ts";

/** A subscription streaming service, trimmed to what the poster badge needs. */
export type BadgeProvider = { id: number; name: string; logo: string | null };

/** How long a cached answer is used before TMDB is asked again. Availability changes slowly. */
export const PROVIDER_CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000;

const keyOf = (mediaType: MediaKind, tmdbId: number) => `${mediaType}:${tmdbId}`;

/** Cached providers that are still fresh, keyed "movie:123". Titles not in the map need fetching. */
export function getFreshProviders(
  items: { mediaType: MediaKind; tmdbId: number }[],
  region: string,
  now = Date.now(),
): Map<string, BadgeProvider[]> {
  const out = new Map<string, BadgeProvider[]>();
  const stmt = getDb().prepare(
    `SELECT providers, fetched_at FROM watch_provider_cache
      WHERE media_type = ? AND tmdb_id = ? AND region = ?`,
  );
  for (const it of items) {
    const row = stmt.get(it.mediaType, it.tmdbId, region) as
      | { providers: string; fetched_at: string }
      | undefined;
    if (!row) continue;
    if (now - Date.parse(row.fetched_at) > PROVIDER_CACHE_TTL_MS) continue;
    try {
      // collapsed again on read, so rows cached before a rule change get it without a refetch
      out.set(keyOf(it.mediaType, it.tmdbId), collapseVariants(JSON.parse(row.providers) as BadgeProvider[]));
    } catch {
      // unreadable row: treat as a miss, it is overwritten on the next save
    }
  }
  return out;
}

export function saveProviders(
  mediaType: MediaKind,
  tmdbId: number,
  region: string,
  providers: BadgeProvider[],
): void {
  getDb()
    .prepare(
      `INSERT INTO watch_provider_cache (media_type, tmdb_id, region, providers, fetched_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(media_type, tmdb_id, region)
       DO UPDATE SET providers = excluded.providers, fetched_at = excluded.fetched_at`,
    )
    .run(mediaType, tmdbId, region, JSON.stringify(providers), nowIso());
}

type RawProvider = {
  provider_id: number;
  provider_name: string;
  logo_path: string | null;
  display_priority?: number;
};

/**
 * The service a provider name is a variant of: "Netflix Standard with Ads" -> "netflix",
 * "Amazon Prime Video with Ads" -> "amazon prime video", "Paramount+ Amazon Channel" ->
 * "paramount plus", "Paramount Plus Premium" -> "paramount plus". Used to show each service once.
 */
export function serviceKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\+/g, " plus ")
    .replace(/\b(standard|basic|premium)?\s*with ads\b/g, " ")
    .replace(/\b(amazon|apple tv|roku premium|prime video)?\s*channels?\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/ (premium plus|premium|essential|standard|basic)$/, "");
}

/** Keeps the first (most prominent) entry of each service, dropping ad-tier and channel variants. */
export function collapseVariants(list: BadgeProvider[]): BadgeProvider[] {
  const seen = new Set<string>();
  return list.filter((p) => {
    const k = serviceKey(p.name) || `id:${p.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * TMDB's subscription ("flatrate") services for one region, as badges: most prominent first, with
 * each service shown once.
 */
export function toBadgeProviders(flatrate: RawProvider[] | undefined): BadgeProvider[] {
  const sorted = [...(flatrate ?? [])].sort(
    (a, b) => (a.display_priority ?? 999) - (b.display_priority ?? 999),
  );
  return collapseVariants(
    sorted.map((p) => ({ id: p.provider_id, name: p.provider_name, logo: p.logo_path })),
  );
}
