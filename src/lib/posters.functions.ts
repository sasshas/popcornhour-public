import { createServerFn } from "@tanstack/react-start";
import { requireUser } from "@/lib/auth-middleware";
import { clearPosterJob, getPosterJob, startPosterJob, type PosterJob } from "@/server/posters-job.server";

export type { PosterJob };

/**
 * Refresh posters: looks posters up again for anything missing one. It runs as a job on the server
 * (posters-job.server.ts), so a phone going to sleep does not stop it: the page starts it, then asks
 * how it is going.
 */
export const getPosterRefreshJob = createServerFn({ method: "GET" })
  .middleware([requireUser])
  .handler(async ({ context }) => getPosterJob(context.userId));

/** Start refreshing. If one is already running, that one is returned. */
export const startPosterRefresh = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .handler(async ({ context }) => startPosterJob(context.userId));

/** Forget a finished refresh, so the screen goes back to just the button. */
export const clearPosterRefreshJob = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .handler(async ({ context }) => {
    clearPosterJob(context.userId);
    return { ok: true };
  });
