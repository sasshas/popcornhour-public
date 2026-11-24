import { createFileRoute } from "@tanstack/react-router";
import { userIdFromRequest } from "@/server/session.server";
import {
  TRAKT_OAUTH_AUTHORIZE,
  buildStateCookie,
  createSignedState,
  getRedirectUri,
  getTraktEnv,
  pkceChallenge,
  pkceVerifier,
  usesPkce,
} from "@/lib/trakt.server";

export const Route = createFileRoute("/api/public/trakt/start")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        // Top-level navigation: the browser sends the session cookie automatically.
        const userId = userIdFromRequest(request);
        if (!userId) return new Response("Unauthorized", { status: 401 });

        const { clientId } = getTraktEnv();
        const redirectUri = getRedirectUri(request.url);
        const state = createSignedState(userId);

        const auth = new URL(TRAKT_OAUTH_AUTHORIZE);
        auth.searchParams.set("response_type", "code");
        auth.searchParams.set("client_id", clientId);
        auth.searchParams.set("redirect_uri", redirectUri);
        auth.searchParams.set("state", state);
        if (usesPkce()) {
          // App with no client secret: Trakt requires PKCE (S256 only).
          auth.searchParams.set("code_challenge", pkceChallenge(pkceVerifier(state)));
          auth.searchParams.set("code_challenge_method", "S256");
        }

        return new Response(null, {
          status: 302,
          headers: {
            Location: auth.toString(),
            "Set-Cookie": buildStateCookie(state),
          },
        });
      },
    },
  },
});
