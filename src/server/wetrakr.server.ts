/**
 * WeTrakr: sign-in with a short code (device flow), token upkeep and read helpers.
 *
 * Everything here reads, except wetrakrPost at the bottom. That is the only way anything is
 * written to the user's WeTrakr account, and it has exactly one caller: sync-push.server.ts,
 * which sends changes the user has looked at and approved in the Sync preview.
 * API notes: https://api.wetrakr.com (headers wetrakr-api-version + wetrakr-api-key).
 */
import { getDb, upsertRow } from "./db.ts";
import { logError, redactText } from "./redact.server.ts";

// WETRAKR_API_URL is for local testing against a fake WeTrakr only; leave it unset on the server.
const API = process.env.WETRAKR_API_URL || "https://api.wetrakr.com";

export function wetrakrConfigured(): boolean {
  return !!process.env.WETRAKR_CLIENT_ID && !!process.env.WETRAKR_CLIENT_SECRET;
}

function env() {
  const clientId = process.env.WETRAKR_CLIENT_ID;
  const clientSecret = process.env.WETRAKR_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("WETRAKR_CLIENT_ID / WETRAKR_CLIENT_SECRET not configured");
  return { clientId, clientSecret };
}

function headers(accessToken?: string): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    "wetrakr-api-version": "1",
    "wetrakr-api-key": env().clientId,
    "User-Agent": "Popcornhour/1.0",
  };
  if (accessToken) h.Authorization = `Bearer ${accessToken}`;
  return h;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function failText(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  // An outage answers with a whole web page; its code says nothing to a reader, so say what it means.
  if (/^\s*</.test(body)) return "(WeTrakr's server had a problem. Try again in a minute.)";
  return redactText(body.slice(0, 200));
}

/** WeTrakr's own server or the gateway in front of it failing for a moment: worth trying again. */
const TEMPORARY = new Set([500, 502, 503, 504]);
const MAX_TEMPORARY_RETRIES = 3;

// ---------- stored connection ----------

export type WetrakrConnectionRow = {
  user_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: string;
  username: string | null;
  connected_at: string;
};

export function getWetrakrConnectionRow(userId: string): WetrakrConnectionRow | null {
  return (
    (getDb().prepare(`SELECT * FROM wetrakr_connections WHERE user_id = ?`).get(userId) as
      | WetrakrConnectionRow
      | undefined) ?? null
  );
}

export function deleteWetrakrConnection(userId: string): void {
  getDb().prepare(`DELETE FROM wetrakr_connections WHERE user_id = ?`).run(userId);
}

type Tokens = { access_token: string; refresh_token: string; expires_in?: number };

const SEVEN_DAYS = 7 * 24 * 3600;

function saveTokens(userId: string, t: Tokens, username?: string | null): void {
  if (!t.access_token || !t.refresh_token) throw new Error("WeTrakr sent no tokens");
  const seconds = typeof t.expires_in === "number" && t.expires_in > 0 ? t.expires_in : SEVEN_DAYS;
  upsertRow(
    "wetrakr_connections",
    {
      user_id: userId,
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      expires_at: new Date(Date.now() + seconds * 1000).toISOString(),
      ...(username !== undefined ? { username } : {}),
    },
    ["user_id"],
  );
}

// ---------- sign-in with a code ----------

type Pending = { deviceCode: string; expiresAt: number; intervalMs: number; nextPollAt: number };
/** The device code stays on the server; the browser only ever sees the short code the user types. */
const pending = new Map<string, Pending>();

export type DeviceStart = { userCode: string; verificationUrl: string; expiresIn: number; interval: number };

export async function startWetrakrSignIn(userId: string): Promise<DeviceStart> {
  const { clientId } = env();
  const res = await fetch(`${API}/oauth/device/code`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ client_id: clientId }),
  });
  if (res.status === 429) throw new Error("Too many sign-in codes were requested. Wait 15 minutes and try again.");
  if (!res.ok) throw new Error(`WeTrakr sign-in could not start: ${res.status} ${await failText(res)}`);
  const j = (await res.json()) as {
    device_code?: string;
    user_code?: string;
    verification_url?: string;
    expires_in?: number;
    interval?: number;
  };
  if (!j.device_code || !j.user_code || !j.verification_url) throw new Error("WeTrakr sent no sign-in code");
  const expiresIn = j.expires_in ?? 600;
  const interval = j.interval ?? 5;
  pending.set(userId, {
    deviceCode: j.device_code,
    expiresAt: Date.now() + expiresIn * 1000,
    intervalMs: interval * 1000,
    nextPollAt: 0,
  });
  return { userCode: j.user_code, verificationUrl: j.verification_url, expiresIn, interval };
}

export type DevicePoll =
  | { state: "pending" }
  | { state: "connected"; username: string | null }
  | { state: "expired" | "denied" | "none" }
  | { state: "error"; message: string };

/** Ask WeTrakr once whether the code was approved. Safe to call often: it never polls faster than allowed. */
export async function pollWetrakrSignIn(userId: string): Promise<DevicePoll> {
  const p = pending.get(userId);
  if (!p) return { state: "none" };
  if (Date.now() > p.expiresAt) {
    pending.delete(userId);
    return { state: "expired" };
  }
  if (Date.now() < p.nextPollAt) return { state: "pending" };
  p.nextPollAt = Date.now() + p.intervalMs;

  const { clientId, clientSecret } = env();
  const res = await fetch(`${API}/oauth/device/token`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ code: p.deviceCode, client_id: clientId, client_secret: clientSecret }),
  });
  if (res.status === 200) {
    pending.delete(userId);
    const tokens = (await res.json()) as Tokens;
    saveTokens(userId, tokens, null);
    const username = await fetchUsername(tokens.access_token).catch((e) => {
      logError("WeTrakr: could not read the account name", e);
      return null;
    });
    if (username) saveTokens(userId, tokens, username);
    return { state: "connected", username };
  }
  if (res.status === 429) {
    p.intervalMs += 2000;
    p.nextPollAt = Date.now() + p.intervalMs;
    return { state: "pending" };
  }
  const text = await failText(res);
  if (res.status === 400 && text.includes("authorization_pending")) return { state: "pending" };
  pending.delete(userId);
  if (res.status === 410) return { state: "expired" };
  if (res.status === 418) return { state: "denied" };
  logError(`WeTrakr sign-in failed: ${res.status} ${text}`);
  return { state: "error", message: `WeTrakr refused the sign-in (${res.status}).` };
}

export function cancelWetrakrSignIn(userId: string): void {
  pending.delete(userId);
}

async function fetchUsername(accessToken: string): Promise<string | null> {
  const j = await wetrakrGet<{ info?: { username?: unknown } }>("/account/settings", accessToken);
  const name = j.info?.username;
  return typeof name === "string" && name ? name : null;
}

/** Ends the session on WeTrakr (best effort) and forgets the tokens here. */
export async function disconnectWetrakr(userId: string): Promise<void> {
  const row = getWetrakrConnectionRow(userId);
  if (row) {
    await fetch(`${API}/oauth/logout`, {
      method: "POST",
      headers: headers(row.access_token),
      body: JSON.stringify({ refresh_token: row.refresh_token }),
    }).catch(() => {});
  }
  deleteWetrakrConnection(userId);
}

// ---------- token upkeep ----------

const refreshing = new Map<string, Promise<string>>();

/** A valid access token, refreshed when it is within a day of expiring. Throws when not connected. */
export async function withWetrakrToken(userId: string): Promise<string> {
  const row = getWetrakrConnectionRow(userId);
  if (!row) throw new Error("Not connected to WeTrakr");
  if (new Date(row.expires_at).getTime() - Date.now() > 24 * 3600 * 1000) return row.access_token;

  // WeTrakr rotates the refresh token on every use, so overlapping refreshes must share one request.
  let inflight = refreshing.get(userId);
  if (!inflight) {
    inflight = refreshAndStore(userId, row.refresh_token).finally(() => refreshing.delete(userId));
    refreshing.set(userId, inflight);
  }
  return inflight;
}

async function refreshAndStore(userId: string, refreshToken: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${API}/oauth/token/refresh`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
  } catch (e) {
    logError("WeTrakr token refresh failed (connection kept)", e);
    throw new Error("Couldn't reach WeTrakr right now. Your connection was kept; please try again shortly.");
  }
  if (res.status === 401) {
    // The refresh token is dead and will never work again: show Connect instead of failing forever.
    deleteWetrakrConnection(userId);
    throw new Error("Your WeTrakr sign-in has expired. Please connect WeTrakr again.");
  }
  if (!res.ok) {
    logError(`WeTrakr token refresh failed (connection kept): ${res.status} ${await failText(res)}`);
    throw new Error("Couldn't refresh your WeTrakr sign-in right now. Your connection was kept; please try again shortly.");
  }
  const fresh = (await res.json()) as Tokens;
  saveTokens(userId, fresh);
  return fresh.access_token;
}

// ---------- reads ----------

// VIP allows 1,000 GETs a minute; stay far below it and back off on 429.
let readGapMs = 150;
/** Tests only. */
export function setWetrakrPacingForTests(ms: number) {
  readGapMs = ms;
}
let nextRead = 0;
const MAX_429_RETRIES = 5;
const MAX_PAGES = 1000; // runaway guard

async function wetrakrFetch(path: string, accessToken: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const now = Date.now();
    const wait = Math.max(0, nextRead - now);
    nextRead = Math.max(now, nextRead) + readGapMs;
    if (wait > 0) await sleep(wait);
    const res = await fetch(`${API}${path}`, { headers: headers(accessToken) });
    if (TEMPORARY.has(res.status) && attempt < MAX_TEMPORARY_RETRIES) {
      await res.body?.cancel().catch(() => {});
      await sleep(2000 * 2 ** attempt); // 2, 4, 8 seconds
      continue;
    }
    if (res.status !== 429 || attempt >= MAX_429_RETRIES) return res;
    const retryAfter = Number(res.headers.get("retry-after") ?? res.headers.get("ratelimit-reset"));
    const waitMs = Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt, 60_000);
    await res.body?.cancel().catch(() => {});
    await sleep(waitMs);
  }
}

export async function wetrakrGet<T>(path: string, accessToken: string): Promise<T> {
  const res = await wetrakrFetch(path, accessToken);
  if (!res.ok) throw new Error(`WeTrakr GET ${redactText(path)} failed: ${res.status} ${await failText(res)}`);
  return res.json() as Promise<T>;
}

export type WetrakrPaged<T> = { items: T[]; pages: number; reportedTotal: number | null };

/** Every page of a page-numbered WeTrakr list (100 a page, the most it allows). */
export async function wetrakrGetAll<T>(
  path: string,
  accessToken: string,
  /** Told after each page: which page that was, and how many WeTrakr says there are. */
  onPage?: (page: number, pageCount: number) => void,
): Promise<WetrakrPaged<T>> {
  const sep = path.includes("?") ? "&" : "?";
  const items: T[] = [];
  let page = 1;
  let pageCount = 1;
  let reportedTotal: number | null = null;
  while (page <= pageCount && page <= MAX_PAGES) {
    const p = `${path}${sep}page=${page}&limit=100`;
    const res = await wetrakrFetch(p, accessToken);
    if (!res.ok) throw new Error(`WeTrakr GET ${redactText(p)} failed: ${res.status} ${await failText(res)}`);
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body)) throw new Error(`WeTrakr GET ${redactText(path)}: expected a list`);
    items.push(...(body as T[]));
    const pc = Number(res.headers.get("x-pagination-page-count"));
    const ic = res.headers.get("x-pagination-item-count");
    if (Number.isFinite(pc) && pc > 0) pageCount = pc;
    if (ic !== null && Number.isFinite(Number(ic))) reportedTotal = Number(ic);
    onPage?.(page, pageCount);
    if (body.length === 0) break;
    page += 1;
  }
  return { items, pages: Math.min(page, pageCount), reportedTotal };
}

// ---------- the one write ----------

let writeGapMs = 400;
/** Tests only. */
export function setWetrakrWritePacingForTests(ms: number) {
  writeGapMs = ms;
}
let nextWrite = 0;

/**
 * POST one change to WeTrakr. Only sync-push.server.ts calls this. `idempotencyKey` makes a
 * repeat of the same request (a retry after a dropped connection) replay the first answer
 * instead of applying the change twice.
 */
export function wetrakrPost<T>(path: string, body: unknown, accessToken: string, idempotencyKey: string): Promise<T> {
  return wetrakrSend<T>("POST", path, body, accessToken, idempotencyKey) as Promise<T>;
}

/** POST, PUT or DELETE. Answers with the JSON body, or null when there is none. */
export async function wetrakrSend<T>(
  method: "POST" | "PUT" | "DELETE",
  path: string,
  body: unknown,
  accessToken: string,
  idempotencyKey: string,
): Promise<T | null> {
  for (let attempt = 0; ; attempt++) {
    const now = Date.now();
    const wait = Math.max(0, nextWrite - now);
    nextWrite = Math.max(now, nextWrite) + writeGapMs;
    if (wait > 0) await sleep(wait);
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { ...headers(accessToken), "Idempotency-Key": idempotencyKey },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.status === 429 && attempt < MAX_429_RETRIES) {
      const retryAfter = Number(res.headers.get("retry-after") ?? res.headers.get("ratelimit-reset"));
      await res.body?.cancel().catch(() => {});
      await sleep(Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt, 60_000));
      continue;
    }
    // Safe to send again: the same Idempotency-Key makes WeTrakr replay its first answer instead of applying it twice.
    if (TEMPORARY.has(res.status) && attempt < MAX_TEMPORARY_RETRIES) {
      await res.body?.cancel().catch(() => {});
      await sleep(2000 * 2 ** attempt);
      continue;
    }
    if (!res.ok) throw new Error(`WeTrakr ${method} ${redactText(path)} failed: ${res.status} ${await failText(res)}`);
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : null;
  }
}
