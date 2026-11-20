import { useQuery } from "@tanstack/react-query";
import { getProviderBadges } from "@/lib/tmdb.functions";
import { useRegion } from "@/hooks/use-region";

export type BadgeProvider = { id: number; name: string; logo: string | null };
type Kind = "movie" | "tv";

type Pending = {
  mediaType: Kind;
  tmdbId: number;
  resolve: (p: BadgeProvider[]) => void;
};

// Posters ask one at a time as they scroll into view. Requests made within a few milliseconds of each
// other are sent to the server as one call (per region), instead of one call per poster.
const BATCH_MS = 40;
const BATCH_MAX = 60;
let queue: { region: string; req: Pending }[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

async function flush() {
  timer = null;
  const batch = queue;
  queue = [];
  const byRegion = new Map<string, Pending[]>();
  for (const { region, req } of batch) {
    const list = byRegion.get(region) ?? [];
    list.push(req);
    byRegion.set(region, list);
  }
  for (const [region, reqs] of byRegion) {
    for (let i = 0; i < reqs.length; i += BATCH_MAX) {
      const chunk = reqs.slice(i, i + BATCH_MAX);
      try {
        const res = await getProviderBadges({
          data: { region, items: chunk.map((r) => ({ mediaType: r.mediaType, tmdbId: r.tmdbId })) },
        });
        const byKey = new Map(res.map((r) => [`${r.mediaType}:${r.tmdbId}`, r.providers]));
        for (const r of chunk) r.resolve(byKey.get(`${r.mediaType}:${r.tmdbId}`) ?? []);
      } catch {
        for (const r of chunk) r.resolve([]); // badges are decoration: never break a poster
      }
    }
  }
}

function requestProviders(region: string, mediaType: Kind, tmdbId: number): Promise<BadgeProvider[]> {
  return new Promise((resolve) => {
    queue.push({ region, req: { mediaType, tmdbId, resolve } });
    if (!timer) timer = setTimeout(flush, BATCH_MS);
  });
}

/** Subscription services a title is on in the user's region. Fetches only once `enabled`. */
export function useProviderBadges(mediaType: string | undefined, tmdbId: number | string, enabled: boolean) {
  const region = useRegion();
  const id = Number(tmdbId);
  const kind: Kind | null = mediaType === "movie" || mediaType === "tv" ? mediaType : null;
  return useQuery({
    queryKey: ["provider-badges", region, kind, id],
    queryFn: () => requestProviders(region!, kind!, id),
    enabled: enabled && !!region && !!kind && Number.isFinite(id) && id > 0,
    staleTime: 1000 * 60 * 60 * 6,
  });
}
