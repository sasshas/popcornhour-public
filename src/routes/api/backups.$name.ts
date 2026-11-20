import { createFileRoute } from "@tanstack/react-router";
import { readFile } from "node:fs/promises";
import { backupPath } from "@/server/backup.server";
import { userIdFromRequest } from "@/server/session.server";

/** Download one backup file. Signed-in only; the name must be an exact backup file name. */
export const Route = createFileRoute("/api/backups/$name")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (!userIdFromRequest(request)) return new Response("Unauthorized", { status: 401 });
        let file: string;
        try {
          file = backupPath(params.name);
        } catch {
          return new Response("Not found", { status: 404 });
        }
        const body = await readFile(file);
        return new Response(new Uint8Array(body), {
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(body.length),
            "Content-Disposition": `attachment; filename="${params.name}"`,
            "Cache-Control": "no-store",
          },
        });
      },
    },
  },
});
