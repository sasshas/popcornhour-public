import { timingSafeEqual } from "node:crypto";
import { logError } from "./redact.server.ts";

/**
 * Shared by the endpoints other apps on the LAN call without a sign-in cookie (Ultrahour, the disc tracker):
 * /api/public/lists/<id>/items and /api/public/watched. All need `Authorization: Bearer <LIST_API_TOKEN>`
 * and are switched off (503) while LIST_API_TOKEN is empty.
 */

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/** The response to send back when the request may not go ahead (switched off, or a wrong token); null when it may. */
export function refuseUnlessToken(request: Request): Response | null {
  const secret = process.env.LIST_API_TOKEN;
  if (!secret) return json({ error: "LIST_API_TOKEN is not configured" }, 503);
  const header = request.headers.get("authorization");
  const provided = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!provided) return json({ error: "Unauthorized" }, 401);
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return json({ error: "Unauthorized" }, 401);
  return null;
}

export interface TmdbTitle {
  title?: string;
  name?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  release_date?: string | null;
  first_air_date?: string | null;
}

/** The title's name, artwork and date from TMDB, so what another app adds looks like something added here. */
export async function tmdbTitle(mediaType: "movie" | "tv", tmdbId: number): Promise<TmdbTitle | null> {
  const key = process.env.TMDB_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(
      `https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${key}&language=en-US`,
    );
    return res.ok ? ((await res.json()) as TmdbTitle) : null;
  } catch (e) {
    logError("public api: TMDB lookup failed", e, mediaType, tmdbId);
    return null;
  }
}
