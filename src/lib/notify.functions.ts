import { createServerFn } from "@tanstack/react-start";
import { requireUser } from "@/lib/auth-middleware";

/** Everything the Notifications page of Settings shows. */
export const getNotifyState = createServerFn({ method: "GET" })
  .middleware([requireUser])
  .handler(async () => {
    const { notifyState } = await import("@/server/release-notify.server");
    return notifyState();
  });

export const sendTestNotification = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .handler(async () => {
    const m = await import("@/server/release-notify.server");
    await m.sendTestNotification();
    return { ok: true };
  });

/** The daily check, now: sends anything new about watchlist movies (and notes movies it has not seen before). */
export const runReleaseCheckNow = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .handler(async () => {
    const { runReleaseCheck } = await import("@/server/release-notify.server");
    return runReleaseCheck();
  });
