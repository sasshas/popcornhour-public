import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { cookiesSecure, publicUrl } from "@/server/config.server";
import { logError, redactText } from "@/server/redact.server";
import {
  deleteTraktConnection,
  getTraktConnectionRow,
  saveTraktConnection,
} from "@/server/trakt-store.server";

const TRAKT_API = "https://api.trakt.tv";
const TRAKT_OAUTH_TOKEN = "https://api.trakt.tv/oauth/token";
const TRAKT_OAUTH_REVOKE = "https://api.trakt.tv/oauth/revoke";
export const TRAKT_OAUTH_AUTHORIZE = "https://trakt.tv/oauth/authorize";

export function getTraktEnv() {
  const clientId = process.env.TRAKT_CLIENT_ID;
  const clientSecret = process.env.TRAKT_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("TRAKT_CLIENT_ID / TRAKT_CLIENT_SECRET not configured");
  }
  return { clientId, clientSecret };
}

export function traktHeaders(accessToken?: string) {
  const { clientId } = getTraktEnv();
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    "trakt-api-version": "2",
    "trakt-api-key": clientId,
    "User-Agent": "Popcornhour/1.0",
  };
  if (accessToken) h.Authorization = `Bearer ${accessToken}`;
  return h;
}

// --- Signed state cookie for OAuth (binds the user_id to the OAuth round-trip)

const STATE_COOKIE = "trakt_oauth_state";

function sign(payload: string, secret: string) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createSignedState(userId: string) {
  const { clientSecret } = getTraktEnv();
  const nonce = randomBytes(16).toString("base64url");
  const payload = `${userId}.${nonce}.${Date.now()}`;
  const sig = sign(payload, clientSecret);
  return `${payload}.${sig}`;
}

export function verifySignedState(token: string | null | undefined): { userId: string } | null {
  if (!token) return null;
  const { clientSecret } = getTraktEnv();
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [userId, nonce, ts, sig] = parts;
  const expected = sign(`${userId}.${nonce}.${ts}`, clientSecret);
  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  // 15-minute expiry
  if (Date.now() - Number(ts) > 15 * 60 * 1000) return null;
  return { userId };
}

export function buildStateCookie(value: string) {
  return `${STATE_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=900${cookiesSecure() ? "; Secure" : ""}`;
}
export function clearStateCookie() {
  return `${STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${cookiesSecure() ? "; Secure" : ""}`;
}
export function readStateCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const m = cookieHeader.split(/;\s*/).find((c) => c.startsWith(`${STATE_COOKIE}=`));
  return m ? m.slice(STATE_COOKIE.length + 1) : null;
}

// --- Token lifecycle

export type TraktTokens = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  created_at: number;
  scope?: string;
};

export async function exchangeCodeForTokens(code: string, redirectUri: string): Promise<TraktTokens> {
  const { clientId, clientSecret } = getTraktEnv();
  const res = await fetch(TRAKT_OAUTH_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "Popcornhour/1.0" },
    body: JSON.stringify({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`Trakt token exchange failed: ${res.status} ${await failText(res)}`);
  return res.json();
}

async function refreshTokens(refreshToken: string, redirectUri: string): Promise<TraktTokens> {
  const { clientId, clientSecret } = getTraktEnv();
  const res = await fetch(TRAKT_OAUTH_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "Popcornhour/1.0" },
    body: JSON.stringify({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    const text = await failText(res);
    let oauthError: string | null = null;
    try {
      const j = JSON.parse(text) as { error?: unknown };
      if (typeof j.error === "string") oauthError = j.error;
    } catch {
      // body wasn't JSON (HTML error page from a proxy/CDN): not an OAuth rejection
    }
    throw new TraktRefreshError(res.status, oauthError, `Trakt token refresh failed: ${res.status} ${text}`);
  }
  return res.json();
}

/** Trakt answered the refresh request with an HTTP error (network failures are NOT this type). */
export class TraktRefreshError extends Error {
  readonly status: number;
  readonly oauthError: string | null;

  constructor(status: number, oauthError: string | null, message: string) {
    super(message);
    this.name = "TraktRefreshError";
    this.status = status;
    this.oauthError = oauthError;
  }

  /**
   * True only when Trakt rejected the refresh token itself (invalid_grant / 400 / 401), meaning
   * the user must reconnect. 5xx, 429 and network errors are temporary. `invalid_client` means
   * OUR client id/secret is wrong: reconnecting would not help, so the connection is kept.
   */
  get tokenRejected(): boolean {
    if (this.oauthError === "invalid_client") return false;
    return this.status === 400 || this.status === 401 || this.oauthError === "invalid_grant";
  }
}

export async function revokeToken(accessToken: string) {
  const { clientId, clientSecret } = getTraktEnv();
  await fetch(TRAKT_OAUTH_REVOKE, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "Popcornhour/1.0" },
    body: JSON.stringify({
      token: accessToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  }).catch(() => {});
}

export async function saveTokensForUser(
  userId: string,
  tokens: TraktTokens,
  profile?: { id: string; username: string; slug: string } | null,
) {
  const expiresAt = new Date((tokens.created_at + tokens.expires_in) * 1000).toISOString();
  saveTraktConnection(userId, {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: expiresAt,
    scope: tokens.scope ?? null,
    ...(profile
      ? {
          trakt_user_id: profile.id,
          trakt_username: profile.username,
          trakt_slug: profile.slug,
        }
      : {}),
  });
}

/**
 * Returns a valid access token for the user, refreshing if it's near expiry.
 * Throws if the user has no Trakt connection.
 */
export async function withTraktToken(userId: string, redirectUri: string): Promise<string> {
  const data = getTraktConnectionRow(userId);
  if (!data) throw new Error("Not connected to Trakt");

  const expiresMs = new Date(data.expires_at).getTime();
  if (expiresMs - Date.now() > 5 * 60 * 1000) return data.access_token;

  // Trakt rotates the refresh token on every use, so two overlapping refreshes would make the
  // second one fail with invalid_grant. Share one in-flight refresh per user.
  let inflight = refreshing.get(userId);
  if (!inflight) {
    inflight = refreshAndStore(userId, data.refresh_token, redirectUri).finally(() =>
      refreshing.delete(userId),
    );
    refreshing.set(userId, inflight);
  }
  return inflight;
}

const refreshing = new Map<string, Promise<string>>();

async function refreshAndStore(userId: string, refreshToken: string, redirectUri: string) {
  let fresh: TraktTokens;
  try {
    fresh = await refreshTokens(refreshToken, redirectUri);
  } catch (e) {
    if (e instanceof TraktRefreshError && e.tokenRejected) {
      // The refresh token is dead (revoked/expired). Clear the stale connection so the UI
      // shows "Connect Trakt" again instead of silently failing every action.
      deleteTraktConnection(userId);
      throw new Error(
        "Your Trakt session has expired. Please reconnect your Trakt account and try again.",
      );
    }
    // Network error, 5xx, 429, or a problem with our own client credentials: the user's
    // connection may be perfectly fine, so keep it and fail only this call.
    logError("Trakt token refresh failed (connection kept)", e);
    throw new Error(
      "Couldn't refresh your Trakt session right now. Your connection was kept; please try again shortly.",
    );
  }
  await saveTokensForUser(userId, fresh);
  return fresh.access_token;
}

// --- Trakt API helpers

// Trakt allows 1000 GETs per 5 minutes per user, and one POST/PUT/DELETE per second; keep inside
// both and back off on 429.
const pacing = { read: 350, write: 1100 };
/** Tests only: shrink the delays so mock-driven runs finish quickly. */
export function setTraktPacingForTests(readMs: number, writeMs: number) {
  pacing.read = readMs;
  pacing.write = writeMs;
}
const MAX_429_RETRIES = 5;
const MAX_RETRY_WAIT_MS = 60_000;
const PAGE_LIMIT = 100;
const MAX_PAGES = 1000; // runaway guard, far above any real library

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const nextSlot = { read: 0, write: 0 };
/** Spaces out Trakt requests process-wide (also correct when callers overlap). */
async function throttle(kind: "read" | "write") {
  const now = Date.now();
  const wait = Math.max(0, nextSlot[kind] - now);
  nextSlot[kind] = Math.max(now, nextSlot[kind]) + pacing[kind];
  if (wait > 0) await sleep(wait);
}

/** One request with throttling and 429 retry (honours Retry-After, else exponential backoff). */
async function traktFetch(
  path: string,
  accessToken: string,
  init?: { method: "POST" | "PUT" | "DELETE"; body?: string },
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    await throttle(init ? "write" : "read");
    const res = await fetch(`${TRAKT_API}${path}`, { headers: traktHeaders(accessToken), ...init });
    if (res.status !== 429 || attempt >= MAX_429_RETRIES) return res;
    const retryAfter = Number(res.headers.get("retry-after"));
    const waitMs = Math.min(
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt,
      MAX_RETRY_WAIT_MS,
    );
    await res.body?.cancel().catch(() => {});
    console.warn(
      `[trakt] 429 on ${redactText(path)}; retry ${attempt + 1}/${MAX_429_RETRIES} in ${Math.round(waitMs / 1000)}s`,
    );
    await sleep(waitMs);
  }
}

async function failText(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  return redactText(body.slice(0, 200));
}

export async function traktGet<T>(path: string, accessToken: string): Promise<T> {
  const res = await traktFetch(path, accessToken);
  if (!res.ok) throw new Error(`Trakt GET ${redactText(path)} failed: ${res.status} ${await failText(res)}`);
  return res.json() as Promise<T>;
}

export type TraktPaged<T> = {
  items: T[];
  pages: number;
  /** Total item count Trakt reported (x-pagination-item-count); null when the endpoint sends none. */
  reportedTotal: number | null;
};

/**
 * GET every page of a paginated Trakt endpoint. Trakt returns 100 items per page and only the
 * first page unless asked, so a single `traktGet` silently truncates large libraries.
 * Endpoints that send no pagination headers (e.g. /sync/ratings) come back as one page.
 */
export async function traktGetAll<T>(
  path: string,
  accessToken: string,
  opts: { limit?: number } = {},
): Promise<TraktPaged<T>> {
  const limit = opts.limit ?? PAGE_LIMIT;
  const sep = path.includes("?") ? "&" : "?";
  const items: T[] = [];
  let page = 1;
  let pageCount = 1;
  let reportedTotal: number | null = null;
  while (page <= pageCount && page <= MAX_PAGES) {
    const p = `${path}${sep}page=${page}&limit=${limit}`;
    const res = await traktFetch(p, accessToken);
    if (!res.ok) throw new Error(`Trakt GET ${redactText(p)} failed: ${res.status} ${await failText(res)}`);
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body)) throw new Error(`Trakt GET ${redactText(path)}: expected a JSON array`);
    items.push(...(body as T[]));
    const pc = Number(res.headers.get("x-pagination-page-count"));
    const ic = Number(res.headers.get("x-pagination-item-count"));
    if (Number.isFinite(pc) && pc > 0) pageCount = pc;
    if (res.headers.get("x-pagination-item-count") !== null && Number.isFinite(ic)) reportedTotal = ic;
    if (body.length === 0) break;
    page += 1;
  }
  return { items, pages: Math.min(page, pageCount), reportedTotal };
}

export async function traktPost<T>(path: string, body: unknown, accessToken: string): Promise<T> {
  const res = await traktFetch(path, accessToken, { method: "POST", body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Trakt POST ${redactText(path)} failed: ${res.status} ${await failText(res)}`);
  return res.json() as Promise<T>;
}

/** PUT or DELETE (lists). Answers with the JSON body, or null when there is none (204). */
export async function traktSend<T>(
  method: "PUT" | "DELETE",
  path: string,
  body: unknown,
  accessToken: string,
): Promise<T | null> {
  const res = await traktFetch(path, accessToken, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`Trakt ${method} ${redactText(path)} failed: ${res.status} ${await failText(res)}`);
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : null;
}

export async function fetchTraktUserProfile(accessToken: string) {
  const data = await traktGet<{ user: { ids: { slug: string }; username: string } }>(
    "/users/settings",
    accessToken,
  );
  return {
    id: data.user.ids.slug,
    username: data.user.username,
    slug: data.user.ids.slug,
  };
}

export function getRedirectUri(originUrl: string): string {
  // PUBLIC_URL wins so the redirect URI matches what is registered with Trakt,
  // regardless of the Host header a reverse proxy forwards.
  const base = publicUrl() ?? new URL(originUrl).origin;
  return `${base}/api/public/trakt/callback`;
}