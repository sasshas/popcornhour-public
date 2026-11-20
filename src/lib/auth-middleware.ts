import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { userIdFromRequest } from "@/server/session.server";

/**
 * Replaces the old Supabase bearer-token middleware. The app is single-user:
 * a valid signed session cookie yields userId "me".
 */
export const requireUser = createMiddleware({ type: "function" }).server(async ({ next }) => {
  const request = getRequest();
  const userId = request ? userIdFromRequest(request) : null;
  if (!userId) throw new Error("Unauthorized");
  return next({ context: { userId } });
});
