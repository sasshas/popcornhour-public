/**
 * Log hygiene: nothing that reaches a log line may contain an API key, token or secret.
 *
 * `redactText` scrubs three ways, so a leak is caught even if the value is in an
 * unexpected place (an error message, a stack, a URL, a JSON body):
 *   1. the exact value of every secret configured in the environment,
 *   2. credential-looking query parameters (`api_key=...`, `code=...`, ...),
 *   3. `Bearer ...` headers and `"access_token": "..."`-style JSON fields.
 *
 * Use `logError` instead of `console.error` anywhere an error may carry a URL or response body.
 */

const SECRET_ENV_VARS = [
  "TMDB_API_KEY",
  "OMDB_API_KEY",
  "MDBLIST_API_KEY",
  "TRAKT_CLIENT_ID",
  "TRAKT_CLIENT_SECRET",
  "WETRAKR_CLIENT_ID",
  "WETRAKR_CLIENT_SECRET",
  "SESSION_SECRET",
  "APP_PASSWORD",
  "CRON_SECRET",
] as const;

const REDACTED = "[redacted]";

const QUERY_PARAM =
  /([?&;\s](?:api_key|apikey|access_token|refresh_token|client_secret|client_id|token|device_code|code|state|password|secret|key)=)[^&\s"'<>]+/gi;
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const JSON_FIELD =
  /("(?:access_token|refresh_token|device_code|client_secret|client_id|api_key|apikey|token|password|secret)"\s*:\s*")[^"]*(")/gi;

export function redactText(input: string): string {
  let out = input;
  for (const name of SECRET_ENV_VARS) {
    const v = process.env[name];
    // Very short values would shred ordinary text; real keys/secrets are longer.
    if (v && v.length >= 6) out = out.split(v).join(REDACTED);
  }
  return out
    .replace(QUERY_PARAM, `$1${REDACTED}`)
    .replace(BEARER, `$1${REDACTED}`)
    .replace(JSON_FIELD, `$1${REDACTED}$2`);
}

/** Error (message, stack and nested `cause`) as one redacted string. */
export function errorText(e: unknown): string {
  if (e instanceof Error) {
    let s = e.stack ?? `${e.name}: ${e.message}`;
    if (e.cause) s += `\n  caused by: ${errorText(e.cause)}`;
    return redactText(s);
  }
  try {
    return redactText(typeof e === "string" ? e : JSON.stringify(e));
  } catch {
    return redactText(String(e));
  }
}

/** Drop-in replacement for `console.error(label, error)` that never prints a credential. */
export function logError(label: string, e?: unknown, ...context: unknown[]): void {
  const ctx = context.length ? " " + redactText(context.map(String).join(" ")) : "";
  console.error(`${redactText(label)}${ctx}${e === undefined ? "" : "\n" + errorText(e)}`);
}

/** Drop-in replacement for `console.log` for free-form diagnostics. */
export function logInfo(message: string): void {
  console.log(redactText(message));
}
