import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getInterestedKeys } from "@/lib/interested.functions";
import { useAuth } from "@/hooks/use-auth";

// One Set per fetched result, shared by every poster (see use-library-status for why).
const sets = new WeakMap<string[], Set<string>>();

/**
 * Whether a title is on the "<name> is interested" list (see interested.functions.ts), and the name for the
 * badge's tooltip. The query key starts with "lists", so the toggle's and the Lists pages'
 * `invalidateQueries({ queryKey: ["lists"] })` calls refresh it.
 */
export function useInterestedMembership() {
  const { user } = useAuth();
  const fetchKeys = useServerFn(getInterestedKeys);
  const { data } = useQuery({
    queryKey: ["lists", "interested-membership", user?.id],
    queryFn: () => fetchKeys(),
    enabled: !!user,
    staleTime: 1000 * 60,
  });
  let set = data && sets.get(data.keys);
  if (data && !set) sets.set(data.keys, (set = new Set(data.keys)));

  return {
    name: data?.name ?? null,
    has: (mediaType: string | undefined, tmdbId: number | string): boolean =>
      !!set?.has(`${mediaType}:${tmdbId}`),
  };
}
