import { createFileRoute } from "@tanstack/react-router";
import {
  clearStateCookie,
  exchangeCodeForTokens,
  fetchTraktUserProfile,
  getRedirectUri,
  readStateCookie,
  saveTokensForUser,
  verifySignedState,
} from "@/lib/trakt.server";
import { logError } from "@/server/redact.server";

function redirect(to: string, extraHeaders: Record<string, string> = {}) {
  return new Response(null, {
    status: 302,
    headers: { Location: to, "Set-Cookie": clearStateCookie(), ...extraHeaders },
  });
}

export const Route = createFileRoute("/api/public/trakt/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const err = url.searchParams.get("error");
        // Never log the query string: it carries the single-use OAuth `code` and the signed `state`.
        if (err) return redirect(`/settings/sync?trakt=error&reason=${encodeURIComponent(err)}`);
        if (!code || !state) return redirect("/settings/sync?trakt=error&reason=missing_params");

        const cookieState = readStateCookie(request.headers.get("cookie"));
        if (!cookieState || cookieState !== state) {
          return redirect("/settings/sync?trakt=error&reason=state_mismatch");
        }
        const verified = verifySignedState(state);
        if (!verified) return redirect("/settings/sync?trakt=error&reason=invalid_state");

        try {
          const redirectUri = getRedirectUri(request.url);
          const tokens = await exchangeCodeForTokens(code, redirectUri);
          const profile = await fetchTraktUserProfile(tokens.access_token).catch(() => null);
          await saveTokensForUser(verified.userId, tokens, profile);
          return redirect("/settings/sync?trakt=connected");
        } catch (e) {
          logError("Trakt callback failed", e);
          return redirect("/settings/sync?trakt=error&reason=exchange_failed");
        }
      },
    },
  },
});