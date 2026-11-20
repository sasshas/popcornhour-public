import { createServerFn } from "@tanstack/react-start";
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";
import { z } from "zod";

export type SessionInfo = { authenticated: boolean; user: { id: string } | null };

export const getSession = createServerFn({ method: "GET" }).handler(async (): Promise<SessionInfo> => {
  const { userIdFromRequest } = await import("@/server/session.server");
  const id = userIdFromRequest(getRequest());
  return id ? { authenticated: true, user: { id } } : { authenticated: false, user: null };
});

export const login = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ password: z.string().min(1).max(500) }).parse(d))
  .handler(async ({ data }) => {
    const { checkPassword, buildSessionCookie } = await import("@/server/session.server");
    const result = checkPassword(data.password);
    if (result === "locked") throw new Error("Too many failed attempts. Try again in a few minutes.");
    if (result === "bad") throw new Error("Incorrect password");
    setResponseHeader("Set-Cookie", buildSessionCookie());
    return { ok: true as const };
  });

export const logout = createServerFn({ method: "POST" }).handler(async () => {
  const { clearSessionCookie } = await import("@/server/session.server");
  setResponseHeader("Set-Cookie", clearSessionCookie());
  return { ok: true as const };
});
