import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getListMembership } from "@/lib/lists.functions";
import { useAuth } from "@/hooks/use-auth";

// One Set per fetched result, shared by every poster (see use-library-status for why).
const sets = new WeakMap<string[], Set<string>>();

/**
 * Whether a title is in any of the user's lists. The query key starts with "lists", so the existing
 * `invalidateQueries({ queryKey: ["lists"] })` calls (after adding/removing/deleting) refresh it.
 */
export function useListMembership() {
  const { user } = useAuth();
  const fetchKeys = useServerFn(getListMembership);
  const { data } = useQuery({
    queryKey: ["lists", "membership", user?.id],
    queryFn: () => fetchKeys(),
    enabled: !!user,
    staleTime: 1000 * 60,
  });
  let set = data && sets.get(data);
  if (data && !set) sets.set(data, (set = new Set(data)));

  return (mediaType: string | undefined, tmdbId: number | string): boolean =>
    !!set?.has(`${mediaType}:${tmdbId}`);
}
