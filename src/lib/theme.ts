// The app's look: the theme (AMOLED or Dark), the accent colour, and the optional liquid-glass style (styles.css).
//
// Each accent colour is just a hue (OKLCH degrees): styles.css derives the accent, focus ring and the
// dark surface tint from the single --h variable, so adding a colour here is all it takes.
// Both choices are saved per browser (like the sort order and streaming country). Liquid glass is ON unless
// someone has switched it off on that browser, so a browser that has lost its saved settings still gets it.

export const ACCENTS = [
  { id: "blue", name: "Blue", hue: 255 }, // the original look
  { id: "violet", name: "Violet", hue: 290 },
  { id: "pink", name: "Pink", hue: 350 },
  { id: "red", name: "Red", hue: 25 },
  { id: "orange", name: "Orange", hue: 55 },
  { id: "green", name: "Green", hue: 150 },
  { id: "teal", name: "Teal", hue: 188 },
  { id: "cyan", name: "Cyan", hue: 220 },
] as const;

export type AccentId = (typeof ACCENTS)[number]["id"];
export const DEFAULT_ACCENT: AccentId = "blue";

const STORAGE_KEY = "cx:accent";

const isAccent = (v: unknown): v is AccentId => ACCENTS.some((a) => a.id === v);

export function getStoredAccent(): AccentId {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (isAccent(v)) return v;
  } catch {}
  return DEFAULT_ACCENT;
}

/** Show this colour now (no save). */
export function applyAccent(id: AccentId): void {
  const hue = ACCENTS.find((a) => a.id === id)?.hue;
  if (hue === undefined) return;
  document.documentElement.style.setProperty("--h", String(hue));
}

/** Show this colour and remember it for next time. */
export function setAccent(id: AccentId): void {
  applyAccent(id);
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {}
}

/** How dark the page is. AMOLED is the original near-black look; Dark is a softer dark grey (styles.css,
 *  `[data-theme="dark"]`), with lighter cards and stronger edges so pills and buttons stand out. */
export const THEMES = [
  { id: "amoled", name: "AMOLED", hint: "Near black. Easiest on an OLED screen's battery.", swatch: "#0d0d0f" },
  { id: "dark", name: "Dark", hint: "Dark grey, with clearer edges on pills and cards.", swatch: "#232325" },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];
export const DEFAULT_THEME: ThemeId = "amoled";

const THEME_KEY = "cx:theme";

const isTheme = (v: unknown): v is ThemeId => THEMES.some((t) => t.id === v);

export function getStoredTheme(): ThemeId {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (isTheme(v)) return v;
  } catch {}
  return DEFAULT_THEME;
}

/** Show this theme now (no save). AMOLED is the stylesheet's default, so it is the absence of data-theme. */
export function applyTheme(id: ThemeId): void {
  const root = document.documentElement;
  if (id === "amoled") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", id);
}

/** Show this theme and remember it for next time. */
export function setTheme(id: ThemeId): void {
  applyTheme(id);
  try {
    localStorage.setItem(THEME_KEY, id);
  } catch {}
}

const GLASS_KEY = "cx:glass";

export function getStoredGlass(): boolean {
  try {
    return localStorage.getItem(GLASS_KEY) !== "0";
  } catch {
    return true;
  }
}

/** Switch the liquid-glass look on or off now (no save). The CSS keys off <html data-glass>. */
export function applyGlass(on: boolean): void {
  const root = document.documentElement;
  if (on) root.setAttribute("data-glass", "");
  else root.removeAttribute("data-glass");
}

/** Switch the liquid-glass look on or off and remember it for next time. */
export function setGlass(on: boolean): void {
  applyGlass(on);
  try {
    localStorage.setItem(GLASS_KEY, on ? "1" : "0");
  } catch {}
}

/**
 * Runs in <head> before the page paints, so the saved colour and glass look are there from the first
 * frame instead of flashing the defaults. Written as plain ES5 text because it is injected as an
 * inline script.
 */
export const THEME_INIT_SCRIPT = `var r=document.documentElement,g=1;try{if(localStorage.getItem(${JSON.stringify(
  GLASS_KEY,
)})==="0")g=0;var m=${JSON.stringify(
  Object.fromEntries(ACCENTS.map((a) => [a.id, a.hue])),
)},h=m[localStorage.getItem(${JSON.stringify(STORAGE_KEY)})];if(h!==undefined)r.style.setProperty("--h",String(h));if(localStorage.getItem(${JSON.stringify(
  THEME_KEY,
)})==="dark")r.setAttribute("data-theme","dark")}catch(e){}if(g)r.setAttribute("data-glass","")`;
