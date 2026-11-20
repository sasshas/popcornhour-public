/**
 * Matching pasted movie titles to TMDB films (a list's Import > "List of titles").
 *
 * One title per line, optionally with a year: "Heat (1995)", "Heat [1995]", "Heat, 1995", "Heat - 1995", "Heat 1995",
 * or a spreadsheet row "Heat<Tab>1995". List markers ("1.", "2)", "-", "•") are ignored.
 *
 * A match is only taken as sure when there is no real doubt; everything else comes back as "unsure" with the likely
 * films, and the person picks (or skips). Sure means:
 *  - a year was given and exactly one film with that exact name came out that year; or
 *  - no year, and exactly one film has that exact name; or several do but one is far better known (20× the votes,
 *    and at least 200 votes): "Heat" is the 1995 film, while "Dune" (2021 vs 1984) is asked about.
 * "Exact name" ignores case, accents, punctuation, "&"/"and" and a leading "The", and accepts the original title.
 */

export type TitleCandidate = {
  tmdbId: number;
  title: string;
  /** The film's own-language title, when different (helps tell films apart). */
  originalTitle: string | null;
  releaseDate: string | null;
  posterPath: string | null;
  backdropPath: string | null;
  votes: number;
};

export type TitleMatch = {
  /** The line as pasted (trimmed). */
  line: string;
  /** What was searched for, and the year read from the line (if any). */
  query: string;
  year: number | null;
  status: "sure" | "unsure" | "none";
  /** The sure match. */
  match: TitleCandidate | null;
  /** For "unsure": the films to choose from, likeliest first (at most 6). */
  candidates: TitleCandidate[];
};

export const TITLE_IMPORT_MAX_LINES = 500;

type Parsed = { line: string; query: string; year: number | null; bareYear: boolean };

const MAX_YEAR = new Date().getFullYear() + 5;
const isYear = (n: number) => n >= 1880 && n <= MAX_YEAR;

/** One pasted line → title + year. null for a blank line. */
export function parseTitleLine(raw: string): Parsed | null {
  const line = raw.trim();
  if (!line) return null;
  // A spreadsheet row: the first cell is the title, a 4-digit cell is the year.
  if (line.includes("\t")) {
    const cells = line.split("\t").map((c) => c.trim()).filter(Boolean);
    const y = cells.slice(1).map(Number).find((n) => Number.isInteger(n) && isYear(n));
    if (cells[0]) return { line, query: cells[0], year: y ?? null, bareYear: false };
  }
  let s = line.replace(/^(?:\d{1,4}[.)]\s+|[-*•·]\s+)/, "").trim();
  if (!s) return null;
  // "(1995)" / "[1995]" at the end, or ", 1995" / " - 1995": clearly a year.
  let m = /^(.*\S)\s*[([]\s*(\d{4})\s*[)\]]$/.exec(s) ?? /^(.*\S)\s*[,–—-]\s*(\d{4})$/.exec(s);
  if (m && isYear(Number(m[2]))) return { line, query: m[1].trim(), year: Number(m[2]), bareYear: false };
  // "Heat 1995": maybe a year, maybe part of the name ("Wonder Woman 1984"); both are tried.
  m = /^(.*\S)\s+(\d{4})$/.exec(s);
  if (m && isYear(Number(m[2]))) return { line, query: m[1].trim(), year: Number(m[2]), bareYear: true };
  return { line, query: s, year: null, bareYear: false };
}

/**
 * Names compared loosely: case, accents, punctuation and "&"/"and" don't count; with `dropThe` a leading "The"
 * doesn't either ("Matrix" finds The Matrix).
 */
export function normTitle(s: string, dropThe = true): string {
  let t = s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, " and ");
  if (dropThe) t = t.replace(/^\s*the\s+/, "");
  return t.replace(/[^a-z0-9]+/g, "");
}

type TmdbMovie = {
  id: number;
  title?: string;
  original_title?: string;
  release_date?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  vote_count?: number;
};

const yearOf = (c: TitleCandidate) => (c.releaseDate ? Number(c.releaseDate.slice(0, 4)) || null : null);

function toCandidate(r: TmdbMovie): TitleCandidate {
  const title = r.title ?? r.original_title ?? "";
  return {
    tmdbId: r.id,
    title,
    originalTitle: r.original_title && r.original_title !== title ? r.original_title : null,
    releaseDate: r.release_date || null,
    posterPath: r.poster_path ?? null,
    backdropPath: r.backdrop_path ?? null,
    votes: r.vote_count ?? 0,
  };
}

/** Decides from search results (pure, so it can be tested without TMDB). */
export function decide(query: string, year: number | null, results: TitleCandidate[]): Omit<TitleMatch, "line"> {
  const named = (dropThe: boolean) => {
    const want = normTitle(query, dropThe);
    return results.filter(
      (c) => normTitle(c.title, dropThe) === want || (c.originalTitle !== null && normTitle(c.originalTitle, dropThe) === want),
    );
  };
  const pick = (exact: TitleCandidate[]): TitleCandidate | null => {
    if (year !== null) {
      const sameYear = exact.filter((c) => yearOf(c) === year);
      return sameYear.length === 1 ? sameYear[0] : null;
    }
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) {
      const [a, b] = [...exact].sort((x, y) => y.votes - x.votes);
      if (a.votes >= 200 && a.votes >= 20 * Math.max(1, b.votes)) return a;
    }
    return null;
  };
  // Word for word first ("Heat" is not "The Heat"), then without a leading "The".
  const strict = named(false);
  const exact = named(true);
  const base = { query, year };
  const sure = (strict.length > 0 ? pick(strict) : null) ?? pick(exact);
  if (sure) return { ...base, status: "sure", match: sure, candidates: [] };
  if (results.length === 0) return { ...base, status: "none", match: null, candidates: [] };
  // Likeliest first: exact names (that year first, then the better known), then the rest in TMDB's order.
  const exactIds = new Set(exact.map((c) => c.tmdbId));
  const ranked = [
    ...[...exact].sort(
      (x, y) =>
        Number(year !== null && yearOf(y) === year) - Number(year !== null && yearOf(x) === year) ||
        (year !== null ? Math.abs((yearOf(x) ?? 0) - year) - Math.abs((yearOf(y) ?? 0) - year) : 0) ||
        y.votes - x.votes,
    ),
    ...results.filter((c) => !exactIds.has(c.tmdbId)),
  ];
  return { ...base, status: "unsure", match: null, candidates: ranked.slice(0, 6) };
}

async function searchMovies(query: string, year: number | null): Promise<TitleCandidate[]> {
  const key = process.env.TMDB_API_KEY;
  if (!key) throw new Error("TMDB_API_KEY not configured");
  const one = async (extra: string) => {
    const url =
      `https://api.themoviedb.org/3/search/movie?api_key=${key}&language=en-US&include_adult=false` +
      `&query=${encodeURIComponent(query)}${extra}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1))); // TMDB asks to slow down
        continue;
      }
      if (!res.ok) throw new Error(`TMDB search ${res.status}`);
      return ((await res.json()) as { results?: TmdbMovie[] }).results ?? [];
    }
    throw new Error("TMDB search: too many requests");
  };
  // With a year, that year's films are searched too, so a lesser-known film of the same name isn't missed.
  const lists = await Promise.all([one(""), year !== null ? one(`&primary_release_year=${year}`) : Promise.resolve([])]);
  const seen = new Set<number>();
  const out: TitleCandidate[] = [];
  for (const r of [...lists[0], ...lists[1]]) {
    if (!r?.id || seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(toCandidate(r));
  }
  return out;
}

async function matchOne(p: Parsed): Promise<TitleMatch> {
  const first = { line: p.line, ...decide(p.query, p.year, await searchMovies(p.query, p.year)) };
  if (first.status === "sure" || !p.bareYear) return first;
  // "Wonder Woman 1984": the number may be part of the name. Try the whole line as the name.
  const whole = p.line.replace(/^(?:\d{1,4}[.)]\s+|[-*•·]\s+)/, "").trim();
  const second = { line: p.line, ...decide(whole, null, await searchMovies(whole, null)) };
  if (second.status === "sure") return second;
  if (first.status === "none") return second;
  return first;
}

/**
 * The pasted text as one title per entry. Several lines: one title per line, as pasted. A single line with commas or
 * semicolons ("Heat, Dune, Parasite", as copied from a web page) is split there. Pieces that are only a year belong
 * to the title before them ("Heat, 1995, Dune, 2021" → "Heat (1995)", "Dune (2021)"), but only when every title has
 * one: in "Heat, 1917, Dune" the 1917 is the film. A name that itself has a comma ("Crazy, Stupid, Love") gets split
 * too in that case; its pieces then mostly come back as unsure or not found, so nothing wrong is added unseen.
 */
export function splitPasted(text: string): string[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length !== 1 || !/[,;]/.test(lines[0]) || lines[0].includes("\t")) return lines;
  const pieces = lines[0].split(/[,;]/).map((p) => p.trim()).filter(Boolean);
  const yearOnly = (p: string) => /^\d{4}$/.test(p) && isYear(Number(p));
  const years = pieces.filter(yearOnly).length;
  const withYears = years > 0 && years >= pieces.length - years;
  const out: string[] = [];
  for (const piece of pieces) {
    if (withYears && yearOnly(piece) && out.length > 0 && !/[([]\d{4}[)\]]$/.test(out[out.length - 1])) {
      out[out.length - 1] += ` (${piece})`;
    } else {
      out.push(piece);
    }
  }
  return out;
}

/** Matches every pasted title (see splitPasted; at most TITLE_IMPORT_MAX_LINES), a few lookups at a time. */
export async function matchTitles(text: string): Promise<{ matches: TitleMatch[]; cutOff: boolean }> {
  const parsed = splitPasted(text).map(parseTitleLine).filter((p): p is Parsed => p !== null);
  const lines = parsed.slice(0, TITLE_IMPORT_MAX_LINES);
  const out: TitleMatch[] = new Array(lines.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(6, lines.length) }, async () => {
      while (next < lines.length) {
        const i = next++;
        try {
          out[i] = await matchOne(lines[i]);
        } catch {
          // One failed lookup doesn't stop the rest; the line shows as not found.
          out[i] = { line: lines[i].line, query: lines[i].query, year: lines[i].year, status: "none", match: null, candidates: [] };
        }
      }
    }),
  );
  return { matches: out, cutOff: parsed.length > lines.length };
}
