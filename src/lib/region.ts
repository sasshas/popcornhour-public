// The streaming region (a TMDB/JustWatch country code). Shared by "Where to watch" on detail pages
// and the streaming badges on posters, so both always agree.

/** Countries TMDB (JustWatch) has streaming data for, alphabetical by name. */
const ALL_REGIONS = [
  ["AR", "Argentina"], ["AU", "Australia"], ["AT", "Austria"], ["BE", "Belgium"], ["BR", "Brazil"],
  ["CA", "Canada"], ["CL", "Chile"], ["CO", "Colombia"], ["CZ", "Czech Republic"], ["DK", "Denmark"],
  ["EG", "Egypt"], ["FI", "Finland"], ["FR", "France"], ["DE", "Germany"], ["GR", "Greece"],
  ["HK", "Hong Kong"], ["HU", "Hungary"], ["IN", "India"], ["ID", "Indonesia"], ["IE", "Ireland"],
  ["IL", "Israel"], ["IT", "Italy"], ["JP", "Japan"], ["MY", "Malaysia"], ["MX", "Mexico"],
  ["NL", "Netherlands"], ["NZ", "New Zealand"], ["NO", "Norway"], ["PE", "Peru"], ["PH", "Philippines"],
  ["PL", "Poland"], ["PT", "Portugal"], ["RO", "Romania"], ["SA", "Saudi Arabia"], ["SG", "Singapore"],
  ["ZA", "South Africa"], ["KR", "South Korea"], ["ES", "Spain"], ["SE", "Sweden"], ["CH", "Switzerland"],
  ["TW", "Taiwan"], ["TH", "Thailand"], ["TR", "Turkey"], ["UA", "Ukraine"], ["AE", "United Arab Emirates"],
  ["GB", "United Kingdom"], ["US", "United States"],
] as const;

/** Listed first, in this order; every other country follows alphabetically. */
const PINNED = ["AU", "US", "GB", "CA"] as const;
export const PINNED_REGION_COUNT = PINNED.length;

/** The countries in display order: the pinned ones, then the rest of the world A–Z. */
export const REGIONS: readonly (readonly [code: string, name: string])[] = [
  ...PINNED.map((code) => ALL_REGIONS.find(([c]) => c === code)!),
  ...ALL_REGIONS.filter(([c]) => !(PINNED as readonly string[]).includes(c)),
];

/**
 * The countries a country menu lists: every one when `all` ("All streaming countries" in Settings > Appearance),
 * else just the pinned ones, plus the chosen country if it is another (so it still shows as chosen).
 */
export function countryChoices(region: string | null, all: boolean): readonly (readonly [code: string, name: string])[] {
  return all ? REGIONS : REGIONS.filter(([code], i) => i < PINNED_REGION_COUNT || code === region);
}

export function regionName(code: string): string {
  return REGIONS.find(([c]) => c === code)?.[1] ?? code;
}

const STORAGE_KEY = "cx:region";

/** The saved region, else the browser's locale country if supported, else US. Browser only. */
export function detectRegion(): string {
  if (typeof window === "undefined") return "US";
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return stored;
  } catch {}
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    const region = locale.split("-")[1]?.toUpperCase();
    if (region && REGIONS.some(([c]) => c === region)) return region;
  } catch {}
  return "US";
}

export function storeRegion(region: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, region);
  } catch {}
  window.dispatchEvent(new CustomEvent("cx:region-change", { detail: region }));
}
