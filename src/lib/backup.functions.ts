import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireUser } from "@/lib/auth-middleware";
import * as backup from "@/server/backup.server";

const Name = z.object({ name: z.string().min(1).max(100) });

/** Everything the Backup section of Settings shows. */
export const getBackupState = createServerFn({ method: "GET" })
  .middleware([requireUser])
  .handler(async () => ({
    folder: backup.backupDir(),
    settings: backup.getBackupSettings(),
    backups: backup.listBackups(),
  }));

export const updateBackupSettings = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .inputValidator((d: unknown) =>
    z.object({ auto: z.boolean().optional(), frequency: z.enum(["daily", "weekly"]).optional() }).parse(d),
  )
  .handler(async ({ data }) => backup.setBackupSettings(data));

export const backupNow = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .handler(async () => backup.createBackup("manual"));

export const deleteBackup = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .inputValidator((d: unknown) => Name.parse(d))
  .handler(async ({ data }) => {
    backup.deleteBackup(data.name);
    return { ok: true };
  });

export const restoreBackup = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .inputValidator((d: unknown) => Name.parse(d))
  .handler(async ({ data }) => backup.restoreBackup(data.name));
