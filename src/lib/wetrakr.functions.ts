import { createServerFn } from "@tanstack/react-start";
import { requireUser } from "@/lib/auth-middleware";
import {
  cancelWetrakrSignIn,
  disconnectWetrakr as disconnect,
  pollWetrakrSignIn,
  startWetrakrSignIn,
  withWetrakrToken,
} from "@/server/wetrakr.server";
import { runWetrakrImport } from "@/server/wetrakr-import.server";
import type { ProgressEvent } from "@/server/trakt-import.server";
import { createBackup } from "@/server/backup.server";
import { logError, redactText } from "@/server/redact.server";

/** Step 1 of signing in: get the short code the user types in at WeTrakr. */
export const startWetrakrConnect = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .handler(async ({ context }) => {
    try {
      return { ok: true as const, ...(await startWetrakrSignIn(context.userId)) };
    } catch (e) {
      logError("WeTrakr: starting sign-in failed", e);
      return { ok: false as const, message: redactText(e instanceof Error ? e.message : "Could not start") };
    }
  });

/** Step 2: has the code been approved yet? The page calls this every few seconds while the code is showing. */
export const checkWetrakrConnect = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .handler(async ({ context }) => {
    try {
      return await pollWetrakrSignIn(context.userId);
    } catch (e) {
      logError("WeTrakr: checking sign-in failed", e);
      return { state: "pending" as const }; // a network blip: keep waiting
    }
  });

export const cancelWetrakrConnect = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .handler(async ({ context }) => {
    cancelWetrakrSignIn(context.userId);
    return { ok: true };
  });

export const disconnectWetrakr = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .handler(async ({ context }) => {
    await disconnect(context.userId);
    return { ok: true };
  });

// Import: WeTrakr -> local library. See src/server/wetrakr-import.server.ts.
export const importFromWetrakr = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .handler(async function* ({ context }): AsyncGenerator<ProgressEvent> {
    let token: string;
    try {
      token = await withWetrakrToken(context.userId);
    } catch (e) {
      logError("WeTrakr import: no usable token", e);
      yield { type: "error", message: redactText(e instanceof Error ? e.message : "Import failed") };
      return;
    }
    // Safety net: the library as it was before this import can be restored from Settings -> Backup.
    try {
      await createBackup("before-import");
    } catch (e) {
      logError("WeTrakr import: backup before import failed", e);
      yield { type: "error", message: "Could not save a backup first, so the import was not started." };
      return;
    }
    yield* runWetrakrImport(context.userId, token);
  });
