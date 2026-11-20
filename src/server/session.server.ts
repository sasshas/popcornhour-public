import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { cookiesSecure, requireEnv } from "./config.server.ts";
import { USER_ID } from "./db.ts";

export const SESSION_COOKIE = "cinexplore_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function sign(payload: string): string {
  return createHmac("sha256", requireEnv("SESSION_SECRET")).update(payload).digest("base64url");
}

function createSessionToken(): string {
  const payload = String(Date.now() + SESSION_TTL_MS);
  return `${payload}.${sign(payload)}`;
}

export function verifySessionToken(token: string | null | undefined): boolean {
  if (!token) return false;
  const [payload, sig, extra] = token.split(".");
  if (!payload || !sig || extra !== undefined) return false;
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  const exp = Number(payload);
  return Number.isFinite(exp) && exp > Date.now();
}

export function readCookie(cookieHeader: string | null | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const m = cookieHeader.split(/;\s*/).find((c) => c.startsWith(`${name}=`));
  return m ? m.slice(name.length + 1) : null;
}

/** Returns the user id if the request carries a valid session cookie, else null. */
export function userIdFromRequest(request: Request): string | null {
  const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  return verifySessionToken(token) ? USER_ID : null;
}

export function buildSessionCookie(): string {
  return (
    `${SESSION_COOKIE}=${createSessionToken()}; Path=/; HttpOnly; SameSite=Lax; ` +
    `Max-Age=${SESSION_TTL_MS / 1000}${cookiesSecure() ? "; Secure" : ""}`
  );
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${cookiesSecure() ? "; Secure" : ""}`;
}

// --- Password check with a crude global brute-force lockout

let failures: number[] = [];
const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000;

export function checkPassword(candidate: string): "ok" | "bad" | "locked" {
  const now = Date.now();
  failures = failures.filter((t) => now - t < WINDOW_MS);
  if (failures.length >= MAX_FAILURES) return "locked";
  const h = (s: string) => createHash("sha256").update(s).digest();
  const ok = timingSafeEqual(h(candidate), h(requireEnv("APP_PASSWORD")));
  if (!ok) {
    failures.push(now);
    return "bad";
  }
  failures = [];
  return "ok";
}
