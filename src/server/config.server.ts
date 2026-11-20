/** Public base URL of this deployment, e.g. https://movies.example.com or http://192.168.1.10:3000 */
export function publicUrl(): string | null {
  const raw = process.env.PUBLIC_URL?.trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, "");
}

/** Cookies get the Secure flag only when the app is served over https. */
export function cookiesSecure(): boolean {
  const u = publicUrl();
  return u ? u.startsWith("https://") : process.env.NODE_ENV === "production";
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not configured`);
  return v;
}
