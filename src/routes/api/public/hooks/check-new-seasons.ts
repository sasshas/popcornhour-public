import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual } from "node:crypto";
import { runShowStatusCheck } from "@/server/tv-status.server";

/**
 * Runs the daily show-status check now (see tv-status.server.ts). It also runs by itself once a day inside the app,
 * so this is only for running it from outside (a cron job with CRON_SECRET).
 */

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
        const r = await runShowStatusCheck();
        return json({ ok: true, checked: r.checked, moved: r.moved, failed: r.failed });
      },
    },
  },
});
