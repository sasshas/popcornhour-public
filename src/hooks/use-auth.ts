import { useQuery } from "@tanstack/react-query";
import { getSession, logout } from "@/lib/auth.functions";

export const SESSION_QUERY_KEY = ["session"] as const;

export type AuthUser = { id: string };

/**
 * Single-user session, backed by a signed cookie (see src/server/session.server.ts).
 * Keeps the `{ session, user, loading }` shape the old Supabase hook returned so
 * existing consumers (and their `user?.id` query keys) are unchanged.
 */
export function useAuth() {
  const { data, isLoading } = useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: () => getSession(),
    staleTime: 60_000,
  });
  const user: AuthUser | null = data?.user ?? null;
  return { session: user ? { user } : null, user, loading: isLoading };
}

export async function signOut() {
  await logout();
  // Hard navigation drops every cached query along with the cookie.
  window.location.assign("/");
}
