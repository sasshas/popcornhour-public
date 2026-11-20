import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listLibrary } from "@/lib/library.functions";
import { useAuth } from "@/hooks/use-auth";

/** `watching`: a show marked Watching (the TV Watching pill). Movies never set it. */
export type LibStatus = { watched: boolean; watching: boolean; watchlist: boolean };
type LibraryRows = Awaited<ReturnType<typeof listLibrary>>;

const NOT_IN_LIBRARY: LibStatus = { watched: false, watching: false, watchlist: false };

// Every poster asks for its own status, so the lookup is built once per fetched library (keyed by the
// fetched array, which React Query keeps stable until the data really changes) and shared by all of them.
const lookups = new WeakMap<LibraryRows, Map<string, LibStatus>>();

function lookupFor(rows: LibraryRows): Map<string, LibStatus> {
  let map = lookups.get(rows);
  if (!map) {
    map = new Map(
      rows.map((r) => [
        `${r.media_type}-${r.tmdb_id}`,
        {
          watched: r.status === "completed",
          watching: r.media_type === "tv" && r.status === "watching",
          watchlist: r.watchlist === true || r.status === "plan_to_watch",
        },
      ]),
    );
    lookups.set(rows, map);
  }
  return map;
}

export function useLibraryStatus() {
  const { user } = useAuth();
  const fetchLib = useServerFn(listLibrary);
  const { data } = useQuery({
    queryKey: ["library", user?.id],
    queryFn: () => fetchLib(),
    enabled: !!user,
    staleTime: 1000 * 60,
  });
  const map = data && lookupFor(data);

  return (mediaType: string | undefined, tmdbId: number | string): LibStatus =>
    map?.get(`${mediaType}-${tmdbId}`) ?? NOT_IN_LIBRARY;
}
