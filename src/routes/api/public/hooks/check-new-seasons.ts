import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual } from "node:crypto";
import { listAllTvItems, patchTvSeasonState } from "@/server/library.server";
import { logError } from "@/server/redact.server";

interface TmdbSeason {
  season_number: number;
  air_date: string | null;
  episode_count: number;
}
interface TmdbTv {
  seasons?: TmdbSeason[];
}

async function fetchTv(id: number): Promise<TmdbTv | null> {
  const key = process.env.TMDB_API_KEY;
  if (!key) throw new Error("TMDB_API_KEY not configured");
  const url = `https://api.themoviedb.org/3/tv/${id}?api_key=${key}&language=en-US`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return (await res.json()) as TmdbTv;
}

function countAiredSeasons(tv: TmdbTv): number {
  const today = new Date().toISOString().slice(0, 10);
  return (tv.seasons ?? []).filter(
    (s) => s.season_number > 0 && s.air_date && s.air_date <= today && s.episode_count > 0,
  ).length;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Accepts `Authorization: Bearer <CRON_SECRET>` or `x-cron-secret: <CRON_SECRET>`. */
function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed: endpoint is disabled until CRON_SECRET is set
  const header = request.headers.get("authorization");
  const provided =
    (header?.startsWith("Bearer ") ? header.slice(7) : null) ?? request.headers.get("x-cron-secret");
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const Route = createFileRoute("/api/public/hooks/check-new-seasons")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!process.env.CRON_SECRET) {
          return json({ error: "CRON_SECRET is not configured" }, 503);
        }
        if (!authorized(request)) return json({ error: "Unauthorized" }, 401);

        const items = listAllTvItems();

        let checked = 0;
        let reactivated = 0;
        let updated = 0;

        for (const item of items) {
          checked++;
          try {
            const tv = await fetchTv(item.tmdb_id);
            if (!tv) continue;
            const aired = countAiredSeasons(tv);
            const prev = item.last_known_seasons ?? 0;
            if (aired === prev) continue;

            const patch: { last_known_seasons: number; status?: "watching" } = {
              last_known_seasons: aired,
            };
            // Only flip back to "watching" if user marked the show as completed/on_hold
            // and a brand new aired season appeared beyond what we last saw.
            if (
              aired > prev &&
              prev > 0 &&
              (item.status === "completed" || item.status === "on_hold")
            ) {
              patch.status = "watching";
              reactivated++;
            }

            patchTvSeasonState(item.id, patch);
            updated++;
          } catch (e) {
            logError("check-new-seasons item failed", e, item.tmdb_id);
          }
        }

        return json({ ok: true, checked, updated, reactivated });
      },
    },
  },
});
